/**
 * 出站：DSH → Java（再由 Java 发到 QQ）。
 *
 * 触发时机只有两个事件：
 *   · `assistant/message` —— 模型说了一句。这里**只攒不发**：
 *     一轮里模型可能输出多次、也可能只发图不发字，所以要能合并。
 *   · `turn/end`          —— 一轮结束。只有 `reason.kind === 'completed'` 才算「真说完了」。
 *
 * 为什么必须等 turn/end：一轮中间可能夹着工具调用、失败的尝试、被中断的输出。
 * 只发「整轮正常完成时的最后一句」才符合「它说完一整轮就发到 QQ」的语义；
 * 被中断/报错的一轮一个字都不发。
 *
 * 拆段、限流、@ 等节奏控制全部交给 Java —— 这里是纯搬运。
 */

import { chatKeyOf } from './config.js'
import {
  extractAttachmentImages,
  extractInlineImages,
  extractText,
  resolveLocalPath,
  summarize,
} from './media.js'
import { sessionKey } from './resolver.js'

/** 这一轮攒到的内容。按会话分开存，避免两个会话同时说话时串台。 */
function emptyDraft() {
  return { turn: -1, text: '', images: [] }
}

export class Outbound {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {import('./resolver.js').SessionResolver} deps.resolver
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {(text: string) => void} deps.log
   * @param {Function} [deps.attachmentsService] 取 DSH attachments 服务
   * @param {(attachmentId: string) => string} [deps.resolveOriginal]
   *        查「附件 id → 我们自己留的原图路径」，用于保住 GIF（DSH 存图可能重编码成静态图）
   */
  constructor(deps) {
    this.getConfig = deps.getConfig
    this.resolver = deps.resolver
    this.bridge = deps.bridge
    this.log = deps.log
    this.attachmentsService = deps.attachmentsService
    this.resolveOriginal = deps.resolveOriginal

    /** @type {Map<string, {turn:number, text:string, images:object[]}>} 会话键 → 本轮草稿 */
    this.drafts = new Map()
    /** @type {Set<string>} 已成功上报的「会话键:轮号」，防重复 */
    this.sentTurns = new Set()
  }

  /** 统一事件入口，由 index.js 挂到 ctx.on('session/event')。 */
  handleSessionEvent(session, event) {
    const config = this.getConfig()
    if (!config.enabled || !config.relayOutbound) return
    if (!config.bindings.length) return

    const sessionId = String((session && session.id) || '')
    if (!sessionId) return
    const key = sessionKey(sessionId)

    if (event && event.type === 'assistant/message') {
      this.#collect(key, event.data || {})
      return
    }
    if (event && event.type === 'turn/end') {
      void this.#finishTurn(sessionId, event.data || {}, config)
    }
  }

  /** 攒住这一轮的正文和图片（只攒，不发）。 */
  #collect(key, data) {
    const draft = this.drafts.get(key) || emptyDraft()

    // 被中断的一次输出不算数 —— 清掉
    if (data.interrupted) {
      this.drafts.set(key, emptyDraft())
      return
    }

    const turn = Number(data.turn)
    const text = extractText(data.message)
    const images = extractAttachmentImages(data.message, 9)

    if (text) {
      this.drafts.set(key, { turn, text, images })
      return
    }
    // 只发图、没发字：把图并进同一轮的正文里，别把图丢了
    if (images.length) {
      const sameTurn = draft.turn === turn
      this.drafts.set(key, {
        turn,
        text: sameTurn ? draft.text : '',
        images: (sameTurn ? draft.images : []).concat(images).slice(0, 9),
      })
    }
  }

  /** 一轮结束：判断该不该发，然后报给 Java。 */
  async #finishTurn(sessionId, data, config) {
    const key = sessionKey(sessionId)
    const draft = this.drafts.get(key) || emptyDraft()
    const turn = Number(data.turn)
    const completed = Boolean(data.reason && data.reason.kind === 'completed')
    const hasContent = Boolean(draft.text) || draft.images.length > 0

    // 发完就清空，不论成功失败 —— 下一轮重新攒
    this.drafts.set(key, emptyDraft())

    if (!completed) return
    if (draft.turn !== turn) return
    if (!hasContent) return

    // 反查：这间会话绑了哪些 QQ 聊天
    const targets = this.resolver.bindingsForSession(sessionId, config.bindings, config.workspacePick)
    if (!targets.length) return   // 很常见：这间会话没绑定任何聊天

    // 去重键必须是「会话 + 轮号」。只用轮号的话，换过会话后轮号撞上会静默漏发。
    const turnKey = key + ':' + turn
    if (this.sentTurns.has(turnKey)) return

    const payload = this.#buildPayload(draft, targets, sessionId, turn)

    try {
      await this.bridge.post('/api/v1/dsh/events', payload)
      // 只在 Java 受理之后才记「发过了」。受理=202，真正的发送与限流在 Java 侧，
      // 这里若重试会造成重复发送，所以不重试。
      this.sentTurns.add(turnKey)
      if (this.sentTurns.size > 500) this.sentTurns.clear()
      this.log(`发出 → ${payload.chatKeys.join(', ')}：${summarize(draft.text)}`
        + (payload.images.length ? `（${payload.images.length} 张图）` : ''))
    } catch (error) {
      this.log(`上报给中转站失败（这一轮不重发）：${String((error && error.message) || error)}`)
    }
  }

  /** 组装发给 Java 的载荷：干净正文 + 图片引用（url / 本机绝对路径）。 */
  #buildPayload(draft, targets, sessionId, turn) {
    const roots = this.resolver.rootsForSession(sessionId)
    const inline = extractInlineImages(draft.text)
    const images = []

    // ① 正文里的 markdown 图：网络图交地址，本地图解析成绝对路径
    for (const ref of inline.images) {
      if (ref.kind === 'url') {
        images.push({ kind: 'url', value: ref.value })
        continue
      }
      const resolved = resolveLocalPath(ref.value, roots)
      if (resolved) {
        images.push({ kind: 'path', value: resolved })
      } else {
        this.log(`找不到图片，跳过：${ref.value}`)
      }
    }

    // ② 附件块：优先换回我们自己留的原图（GIF 不退化），否则用 DSH 的宿主路径
    const service = this.attachmentsService?.()
    for (const block of draft.images) {
      const attachmentId = String((block && block.attachment && block.attachment.attachmentId) || '')
      let path = attachmentId ? String(this.resolveOriginal?.(attachmentId) || '') : ''
      if (!path && service && typeof service.imageHostPath === 'function') {
        try {
          path = String(service.imageHostPath(block.attachment) || '')
        } catch {
          // ignore
        }
      }
      if (path) {
        images.push({ kind: 'path', value: path })
      }
    }

    return {
      sessionKey: sessionId,
      chatKeys: targets.map(chatKeyOf),
      turn,
      text: inline.text,
      images,
    }
  }

  /** 插件卸载时清掉草稿。 */
  dispose() {
    this.drafts.clear()
    this.sentTurns.clear()
  }
}
