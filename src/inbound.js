/**
 * 入站：Java → DSH。
 *
 * 一轮 poll 做这些事：
 *   1. 从 Java 取待投递队列（那些「QQ 里有人说了话」的消息）；
 *   2. 按 chatKey 找到绑定 → 解析到一间活着的会话 → 取它的 agent；
 *   3. 把正文包成 text 块，把图片交给 DSH 附件服务准入；
 *   4. `agent.followup()` 投进会话；
 *   5. **只有投递成功才 ack** —— ack 是 Java 侧推进水位的唯一依据。
 *
 * 为什么「投递成功才 ack」这么重要：ack 会让 Java 认为这条消息已处理并从队列移除。
 * 若先 ack 后投递，一旦投递失败（会话没开 / agent 已释放），这条消息就永久丢失。
 * 反过来只是「下一轮重试」，最坏慢 1.5 秒。
 */

import { extensionOfMime, readAsBase64, summarize } from './media.js'
import { sessionKey } from './resolver.js'

/** 一次最多取多少条待投递消息。 */
const OUTBOX_PAGE_SIZE = 20

/** 「附件 id → 我们自己留的原图路径」内存映射上限。 */
const ORIGINAL_MAP_LIMIT = 200

export class Inbound {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {import('./resolver.js').SessionResolver} deps.resolver
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {(text: string) => void} deps.log
   * @param {Function} [deps.attachmentsService]
   */
  constructor(deps) {
    this.getConfig = deps.getConfig
    this.resolver = deps.resolver
    this.bridge = deps.bridge
    /**
     * 记账。可选第二参数 { level, itemId }。
     * 默认由 index.js 注入的那个实现负责写内存缓冲 + 宿主 logger。
     */
    this.log = deps.log
    /**
     * 在某个 itemId 上下文里执行 —— 让这段代码里打的日志都带上同一个 id。
     * 由 index.js 提供（它持有「当前 itemId」的状态）；缺失时退化为直接执行。
     */
    this.withItemId = deps.withItemId
    this.attachmentsService = deps.attachmentsService

    /** 正在跑的 poll（single-flight 用）。 */
    this.running = null
    /** 插件卸载标记。 */
    this.stopped = false

    /**
     * @type {Map<string, string>} DSH 附件 id → Java 存的原图路径。
     * 回发同一张图时优先用它，GIF 不会因为 DSH 的重编码变成静态图。
     */
    this.originalByAttachment = new Map()
  }

  /**
   * 心跳入口。single-flight：上一次没跑完就直接复用它的 Promise，不叠加。
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

    const page = await this.bridge.get(`/api/v1/dsh/outbox?limit=${OUTBOX_PAGE_SIZE}`)
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
      // true = 已投递；'drop' = 已经没有绑定，ack 掉避免无限积压；false = 留待下一轮
      if (outcome === true || outcome === 'drop') acked.push(message.id)
    }

    if (acked.length) {
      await this.bridge.post('/api/v1/dsh/ack', { ids: acked })
    }
  }

  /**
   * 投一条消息。
   *
   * @returns {Promise<true|'drop'|false>}
   *   true 已投递；'drop' 无绑定该丢弃（要 ack）；false 暂时投不出去（不要 ack）
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

    const resolved = await this.resolver.resolveBinding(binding, config.workspacePick)
    if (resolved.error) {
      this.log(`${chatKey}：${resolved.error}（留待下一轮）`)
      return false
    }

    const agent = this.resolver.findAgent(resolved.sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      this.log(`${chatKey}：会话 …${sessionKey(resolved.sessionId).slice(-8)} 现在没活着（留待下一轮）`)
      return false
    }

    const content = await this.#buildContent(message)
    const input = {
      id: `qq-${message.id}`,
      role: 'user',
      content,
      // ⚠ source.kind 在 DSH 里是封闭枚举，没有 'qq'。
      //   用 'user' 表示「这是一条用户输入」（UI 会正常当作人说的话渲染），
      //   额外的 `qq` 字段承载结构化身份，供二次开发直接读，不必解析正文。
      source: { kind: 'user', qq: message.identity || null },
    }

    // 用 Java 侧的 itemId 作为串联标识：这条消息相关的所有日志都带它，
    // /logs 页面上就能和 Java 侧的行按同一 id 归组。
    const itemId = String(message.id || '')
    const run = async () => {
      try {
        await agent.followup(input)
      } catch (error) {
        this.log(`${chatKey}：followup 失败（${String((error && error.message) || error)}）`,
          { level: 'warn' })
        return false
      }
      this.log(`收到 ${chatKey} → 会话 …${sessionKey(resolved.sessionId).slice(-8)}：`
        + summarize(message.text, 30))
      return true
    }

    return this.withItemId
      ? this.withItemId(itemId, run)
      : run()
  }

  /** 正文块：先文字，再图片（图片要过 DSH 附件服务准入）。 */
  async #buildContent(message) {
    const text = String((message && message.text) || '')
    let content = [{ type: 'text', text }]

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
      // 记下「DSH 附件 id → Java 存的原图」，回发同一张图时用它保住 GIF
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

  #rememberOriginal(attachmentId, path) {
    if (!attachmentId || !path) return
    if (this.originalByAttachment.size >= ORIGINAL_MAP_LIMIT) {
      // 简单的 FIFO 淘汰：Map 保持插入顺序
      const oldest = this.originalByAttachment.keys().next().value
      if (oldest !== undefined) this.originalByAttachment.delete(oldest)
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
