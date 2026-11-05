/**
 * 出站：DSH → Java（再由 Java 发到 QQ）。
 *
 * 只响应两个事件：
 *   · `assistant/message` —— 模型说了一段，**只攒不发**（一轮里可能说多次）；
 *   · `turn/end`          —— 一轮结束，且 `reason.kind === 'completed'` 才发。
 *
 * 为什么必须等 turn/end：一轮中间可能夹着工具调用、失败重试、被中断的输出。
 * 只发「整轮正常完成时的内容」才符合语义；被中断的一轮一个字都不发。
 *
 * **发给谁**：只看 {@link TurnOrigin} 记的「这一轮由哪个聊天触发」。
 *   有来源 → 只发那一个聊天（修掉「群说话、私聊也收到」的广播问题）；
 *   无来源 → 用户在 DSH 里手动说话，**一个字都不发**。
 *
 * 拆段、限流等节奏控制全在 Java —— 这里是纯搬运。
 */

import { API } from './api.js'
import { MAX_IMAGES_PER_TURN, SENT_TURNS_LIMIT, SUMMARY_LEN } from './constants.js'
import { chatKeyOf } from './config.js'
import { SESSION_EVENT, TURN_REASON } from './events.js'
import {
  extractAttachmentImages,
  extractInlineImages,
  extractText,
  resolveLocalPath,
  summarize,
} from './media.js'
import { sessionKey, shortId } from './session-id.js'

/** 一轮攒到的内容。按会话分开存，避免两个会话同时说话时串台。 */
function emptyDraft() {
  return { turn: -1, text: '', images: [] }
}

export class Outbound {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {import('./resolver.js').SessionResolver} deps.resolver
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {import('./origin.js').TurnOrigin} deps.origin 轮次来源登记
   * @param {(text: string, meta?: object) => void} deps.log
   * @param {Function} [deps.attachmentsService] 取 DSH attachments 服务
   * @param {(attachmentId: string) => string} [deps.resolveOriginal]
   *        查「附件 id → 我们自己留的原图路径」，用于保住 GIF
   */
  constructor(deps) {
    this.getConfig = deps.getConfig
    this.resolver = deps.resolver
    this.bridge = deps.bridge
    this.origin = deps.origin
    this.log = deps.log
    this.attachmentsService = deps.attachmentsService
    this.resolveOriginal = deps.resolveOriginal

    /** @type {Map<string, {turn:number, text:string, images:object[]}>} 会话键 → 本轮草稿 */
    this.drafts = new Map()
    /** @type {Map<string, true>} 已上报的「会话键:轮号」，防重复。Map 保插入顺序，便于 FIFO 淘汰。 */
    this.sentTurns = new Map()
  }

  /** 事件入口，由 index.js 挂到 ctx.on('session/event')。 */
  handleSessionEvent(session, event) {
    const config = this.getConfig()
    if (!config.enabled || !config.relayOutbound) return
    if (!config.bindings.length) return

    const sessionId = String((session && session.id) || '')
    if (!sessionId) return
    const key = sessionKey(sessionId)

    if (event && event.type === SESSION_EVENT.assistantMessage) {
      this.#collect(key, event.data || {})
      return
    }
    if (event && event.type === SESSION_EVENT.turnEnd) {
      void this.#finishTurn(sessionId, event.data || {}, config)
    }
  }

  /** 攒住这一轮的正文和图片。 */
  #collect(key, data) {
    const draft = this.drafts.get(key) || emptyDraft()

    // 被中断的一次输出不算数
    if (data.interrupted) {
      this.drafts.set(key, emptyDraft())
      return
    }

    const turn = Number(data.turn)
    const text = extractText(data.message)
    const images = extractAttachmentImages(data.message, MAX_IMAGES_PER_TURN)

    if (text) {
      this.drafts.set(key, { turn, text, images })
      return
    }
    // 只发图没发字：把图并进同一轮，别丢
    if (images.length) {
      const sameTurn = draft.turn === turn
      this.drafts.set(key, {
        turn,
        text: sameTurn ? draft.text : '',
        images: (sameTurn ? draft.images : []).concat(images).slice(0, MAX_IMAGES_PER_TURN),
      })
    }
  }

  /** 一轮结束：判断该不该发、发给谁，然后报给 Java。 */
  async #finishTurn(sessionId, data, config) {
    const key = sessionKey(sessionId)
    const draft = this.drafts.get(key) || emptyDraft()
    const turn = Number(data.turn)
    const completed = Boolean(data.reason && data.reason.kind === TURN_REASON.completed)
    const hasContent = Boolean(draft.text) || draft.images.length > 0

    // 不论成败都清空，下一轮重新攒
    this.drafts.set(key, emptyDraft())

    if (!completed || draft.turn !== turn || !hasContent) return

    // 只回给「触发这一轮的那个聊天」。
    // 取不到来源 = 用户在 DSH 里手动说话，不该跑到 QQ 上。
    const originChat = this.origin.of(sessionId)
    this.origin.consume(sessionId)

    if (!originChat) {
      this.log(`会话 …${shortId(sessionId)} 这一轮没有 QQ 来源（手动触发），不发到 QQ`)
      return
    }

    const binding = config.bindings.find(
      (item) => item.enabled !== false && chatKeyOf(item) === originChat,
    )
    if (!binding) {
      // 来源聊天在此期间被删了，只能放弃这一轮
      this.log(`${originChat} 已无绑定，这一轮不发`)
      return
    }

    // 去重键必须是「会话 + 轮号」：只用轮号的话，换会话后号码撞上会静默漏发
    const turnKey = `${key}:${turn}`
    if (this.sentTurns.has(turnKey)) return

    const payload = this.#buildPayload(draft, [binding], sessionId, turn)

    try {
      await this.bridge.post(API.events, payload)
      // 只在 Java 受理后才记「发过了」。受理即 202，真正的发送与限流在 Java，
      // 这里重试会造成重复发送，所以不重试。
      this.#rememberTurn(turnKey)
      this.log(`发出 → ${payload.chatKeys.join(', ')}：${summarize(draft.text, SUMMARY_LEN)}`
        + (payload.images.length ? `（${payload.images.length} 张图）` : ''))
    } catch (error) {
      this.log(`上报给中转站失败（这一轮不重发）：${String((error && error.message) || error)}`)
    }
  }

  /** FIFO 淘汰。整表 clear() 会丢掉全部去重记录，之后轮号撞上就重复发。 */
  #rememberTurn(turnKey) {
    this.sentTurns.set(turnKey, true)
    while (this.sentTurns.size > SENT_TURNS_LIMIT) {
      const oldest = this.sentTurns.keys().next().value
      if (oldest === undefined) break
      this.sentTurns.delete(oldest)
    }
  }

  /** 组装载荷：干净正文 + 图片引用（url / 本机绝对路径）。 */
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

    // ② 附件块：优先换回我们自己留的原图（GIF 不退化），否则用 DSH 宿主路径
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
      if (path) images.push({ kind: 'path', value: path })
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
