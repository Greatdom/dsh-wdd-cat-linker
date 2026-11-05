/**
 * 入站：Java → DSH。
 *
 * 一轮轮询做这些事：
 *   1. 从 Java 取待投递队列；
 *   2. 按 chatKey 找绑定 → 解析到一间会话（agent 不在内存里就恢复）；
 *   3. 正文包成 text 块，图片交给 DSH 附件服务准入；
 *   4. `agent.followup()` 投进会话；
 *   5. **只有投递成功才 ack**。
 *
 * 为什么「投递成功才 ack」：ack 会让 Java 把消息从队列移除。先 ack 后投递，
 * 一旦投递失败这条消息就永久丢失；反过来只是下一轮重试，最坏慢一个轮询间隔。
 */

import { API } from './api.js'
import {
  DELIVERY_SUMMARY_LEN,
  ORIGINAL_MAP_LIMIT,
  OUTBOX_PAGE_SIZE,
} from './constants.js'
import { extensionOfMime, readAsBase64, summarize } from './media.js'
import { shortId } from './session-id.js'

export class Inbound {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {import('./resolver.js').SessionResolver} deps.resolver
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {import('./origin.js').TurnOrigin} deps.origin 轮次来源登记
   * @param {(text: string, meta?: object) => void} deps.log
   * @param {Function} [deps.attachmentsService]
   */
  constructor(deps) {
    this.getConfig = deps.getConfig
    this.resolver = deps.resolver
    this.bridge = deps.bridge
    this.origin = deps.origin
    this.log = deps.log
    this.attachmentsService = deps.attachmentsService

    /** 正在跑的轮询（single-flight 用）。 */
    this.running = null
    this.stopped = false

    /** @type {Map<string, string>} DSH 附件 id → Java 存的原图路径，回发时保住 GIF。 */
    this.originalByAttachment = new Map()
  }

  /**
   * 轮询入口。single-flight：上一轮没跑完就复用它的 Promise，不叠加——
   * 否则同一条消息可能被两轮同时读到并投递两次（followup 不可撤回）。
   */
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.#run()
      .catch((error) => {
        this.log('轮询出错：' + String((error && error.message) || error))
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  async #run() {
    const config = this.getConfig()
    if (!config.enabled || !config.relayInbound) return

    const page = await this.bridge.get(API.outbox(OUTBOX_PAGE_SIZE))
    const messages = Array.isArray(page && page.messages) ? page.messages : []
    if (!messages.length) return

    const acked = []
    for (const message of messages) {
      if (this.stopped) break
      let outcome
      try {
        outcome = await this.#deliver(message, config)
      } catch (error) {
        this.log(`投递 ${message && message.id} 出错：${String((error && error.message) || error)}`)
        outcome = false
      }
      // true = 已投递；'drop' = 已无绑定，ack 掉避免无限积压；false = 留待下一轮
      if (outcome === true || outcome === 'drop') acked.push(message.id)
    }

    if (acked.length) {
      await this.bridge.post(API.ack, { ids: acked })
    }
  }

  /**
   * 投一条消息。
   *
   * @returns {Promise<true|'drop'|false>}
   *   true 已投递；'drop' 该丢弃（要 ack）；false 暂投不出去（不要 ack）
   */
  async #deliver(message, config) {
    if (!message || !message.id) return 'drop'

    const chatKey = String(message.chatKey || '')
    const binding = config.bindings.find(
      (item) => item.enabled !== false && `${item.chatType}:${item.chatId}` === chatKey,
    )
    if (!binding) {
      this.log(`${chatKey} 已经没有绑定，丢弃这条（避免队列无限积压）`)
      return 'drop'
    }

    // resume: true —— 真正的投递才值得付出「从磁盘恢复会话」的代价。
    // 解析结果里已经带上了 agent，不要再去 findAgent 查一遍。
    const resolved = await this.resolver.resolveTarget(binding, {
      pick: config.workspacePick,
      resume: true,
    })
    if (resolved.error) {
      this.log(`${chatKey}：${resolved.error}（留待下一轮）`)
      return false
    }

    const { agent, sessionId } = resolved
    if (!agent || typeof agent.followup !== 'function') {
      this.log(`${chatKey}：会话 …${shortId(sessionId)} 拿不到 followup（留待下一轮）`)
      return false
    }

    const content = await this.#buildContent(message)
    const input = {
      id: `qq-${message.id}`,
      role: 'user',
      content,
      // source.kind 是封闭枚举，没有 'qq'。用 'user' 让 UI 当人话渲染，
      // 结构化身份单独放在 qq 字段里，二次开发不必解析正文。
      source: { kind: 'user', qq: message.identity || null },
    }

    try {
      await agent.followup(input)
    } catch (error) {
      this.log(`${chatKey}：followup 失败（${String((error && error.message) || error)}）`,
        { level: 'warn', itemId: String(message.id) })
      return false
    }

    // 记下来源：DSH 这轮回复只该发回这一个聊天。
    // 不记的话出站无从判断「谁问的」，只能按会话广播，手动说话也拦不住。
    this.origin.remember(sessionId, chatKey)

    // itemId 显式带上，让这条日志和 Java 侧的行能按同一 id 归组
    this.log(`收到 ${chatKey} → 会话 …${shortId(sessionId)}：`
      + summarize(message.text, DELIVERY_SUMMARY_LEN), { itemId: String(message.id) })
    return true
  }

  /** 正文块：先文字，再图片（图片要过 DSH 附件服务准入）。 */
  async #buildContent(message) {
    const text = String((message && message.text) || '')
    const content = [{ type: 'text', text }]

    const images = Array.isArray(message && message.images) ? message.images : []
    if (!images.length) return content

    const service = this.attachmentsService?.()
    if (!service || typeof service.admitPromptContent !== 'function') {
      this.log('宿主没有 attachments 服务，图片跳过（正文里没有图片说明）')
      return content
    }

    const blocks = []
    const usable = []
    for (let i = 0; i < images.length; i += 1) {
      const image = images[i] || {}
      const base64 = readAsBase64(image.path)
      if (!base64) {
        this.log(`第 ${i + 1} 张图读不到，跳过：${image.path}`)
        continue
      }
      blocks.push({
        type: 'image',
        data: base64,
        mediaType: image.mime || 'image/jpeg',
        name: `qq-${message.id}-${i + 1}.${extensionOfMime(image.mime)}`,
      })
      usable.push(image)
    }
    if (!blocks.length) return content

    try {
      const admitted = await service.admitPromptContent(content.concat(blocks))
      const admittedImages = (Array.isArray(admitted) ? admitted : [])
        .filter((block) => block && block.type === 'image' && block.attachment)
      admittedImages.forEach((block, index) => {
        const attachmentId = block.attachment && block.attachment.attachmentId
        const source = usable[index]
        if (attachmentId && source && source.path) {
          this.#rememberOriginal(String(attachmentId), source.path)
        }
      })
      return admitted
    } catch (error) {
      this.log('图片交给 DSH 失败（这条只转文字）：' + String((error && error.message) || error))
      return content
    }
  }

  /** 记下「附件 id → 原图」，FIFO 淘汰。 */
  #rememberOriginal(attachmentId, path) {
    if (!attachmentId || !path) return
    while (this.originalByAttachment.size >= ORIGINAL_MAP_LIMIT) {
      const oldest = this.originalByAttachment.keys().next().value
      if (oldest === undefined) break
      this.originalByAttachment.delete(oldest)
    }
    this.originalByAttachment.set(attachmentId, path)
  }

  /** 供出站查：这张附件对应的原图在哪。 */
  resolveOriginal(attachmentId) {
    return this.originalByAttachment.get(String(attachmentId || '')) || ''
  }

  /** 插件卸载：停止投递。 */
  dispose() {
    this.stopped = true
    this.originalByAttachment.clear()
  }
}
