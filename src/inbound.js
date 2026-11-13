/**
 * 入站：Java → DSH。
 *
 * 一轮轮询做这些事：
 *   1. 从 Java 取待投递队列；
 *   2. 按 Java 标好的 archiveId（或人际关系白名单）找到**目标存档们**；
 *   3. 正文包成 text 块，图片交给 DSH 附件服务准入；
 *   4. 对每个存档的会话各 `agent.followup()` 一次；
 *   5. **全部投递成功才 ack**。
 *
 * 为什么「投递成功才 ack」：ack 会让 Java 把消息从队列移除。先 ack 后投递，
 * 一旦投递失败这条消息就永久丢失；反过来只是下一轮重试，最坏慢一个轮询间隔。
 *
 * 为什么是「目标存档们」：设计文档 Q3 允许抢话——同一个群可被多个存档认领，
 * 都投、都回。
 */

import { API } from './api.js'
import { CHANNEL_QQ } from './config.js'
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
   * @param {import('./archives.js').ArchiveSource} deps.archives 存档源
   * @param {import('./origin.js').TurnOrigin} deps.origin 轮次来源登记
   * @param {(text: string, meta?: object) => void} deps.log
   * @param {Function} [deps.attachmentsService]
   */
  constructor(deps) {
    this.getConfig = deps.getConfig
    this.resolver = deps.resolver
    this.bridge = deps.bridge
    this.archives = deps.archives
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
      // true = 所有目标都投到了；'drop' = 没存档认领，ack 掉避免无限积压；
      // false = 至少有一个目标没投到，留待下一轮
      if (outcome === true || outcome === 'drop') acked.push(message.id)
    }

    if (acked.length) {
      await this.bridge.post(API.ack, { ids: acked })
    }
  }

  /**
   * 投一条消息。
   *
   * <p><b>一条消息可能投给多个存档</b>（设计文档 Q3：允许抢话）。
   * 比如群 20001 同时被「黑猫」和「白猫」认领，两个模拟人都该看到这句话。
   *
   * <p>每个目标独立成败：
   * <ul>
   *   <li>全部成功 → {@code true}（可以 ack）；</li>
   *   <li>没人认领 → {@code 'drop'}（也要 ack，否则队列无限积压）；</li>
   *   <li>有目标没投到 → {@code false}（不 ack，下一轮重试；
   *       已经投到的会在下一轮被「已处理」挡掉，不会重复投）。</li>
   * </ul>
   *
   * @returns {Promise<true|'drop'|false>}
   */
  async #deliver(message, config) {
    if (!message || !message.id) return 'drop'

    const chatKey = String(message.chatKey || '')
    // Java 已经在 OutboxItem 里标好了归属存档（存档由 Java 托管，它最清楚）
    const archiveId = String(message.archiveId || '')

    // 优先按 Java 指定的存档投；没有就按人际关系白名单反查（兼容过渡期）
    const targets = archiveId
      ? [this.archives.get(archiveId)].filter(Boolean)
      : this.archives.forChat(chatKey)

    if (!targets.length) {
      this.log(`${chatKey} 没有存档认领，丢弃这条（避免队列无限积压）`)
      return 'drop'
    }

    const content = await this.#buildContent(message)
    const channel = String(message.channel || CHANNEL_QQ)

    let delivered = 0
    let failed = 0

    for (const archive of targets) {
      const ok = await this.#deliverTo(archive, message, chatKey, content, channel)
      if (ok) delivered++
      else failed++
    }

    if (delivered === 0) return false
    if (failed > 0) {
      this.log(`${chatKey}：${delivered} 个存档投到，${failed} 个待重试`, { level: 'warn' })
      return false   // 有失败就不 ack，下一轮补
    }
    return true
  }

  /**
   * 投给一个存档。
   *
   * <p>会话必须能从磁盘恢复出来——存档制度下会话可能被回收，
   * 但记忆和人设都在 Java，恢复会话不丢任何东西。
   */
  async #deliverTo(archive, message, chatKey, content, channel) {
    const sessionId = archive.sessionId
    if (!sessionId) {
      this.log(`存档「${archive.name}」没有绑定会话（${archive.sessionStatus}），跳过`)
      return false
    }

    const agent = await this.resolver.resumeAgent(sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      this.log(`存档「${archive.name}」的会话 …${shortId(sessionId)} 打不开，留待下一轮`)
      return false
    }

    const input = {
      // ⚠ id 必须带存档后缀：同一条 QQ 消息投给两个存档时，
      //   两个会话里出现相同 id 会让「按 id 找锚点」的逻辑错乱。
      id: `qq-${message.id}-${archive.id}`,
      role: 'user',
      content,
      // source.kind 是封闭枚举，没有 'qq'。用 'user' 让 UI 当人话渲染，
      // 结构化身份单独放在 qq 字段里，二次开发不必解析正文。
      source: { kind: 'user', qq: message.identity || null },
    }

    try {
      await agent.followup(input)
    } catch (error) {
      this.log(`${chatKey} → 存档「${archive.name}」：followup 失败（`
        + String((error && error.message) || error) + '）',
      { level: 'warn', itemId: String(message.id) })
      return false
    }

    // 记下来源：DSH 这轮回复只该发回这个聊天，而且要用这个存档的身份发。
    // 一个存档只绑一间会话，所以 sessionId ↔ archiveId 是一对一的。
    this.origin.remember(sessionId, { archiveId: archive.id, chatKey, channel })

    // itemId 显式带上，让这条日志和 Java 侧的行能按同一 id 归组
    this.log(`收到 ${chatKey} → 存档「${archive.name}」会话 …${shortId(sessionId)}：`
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
