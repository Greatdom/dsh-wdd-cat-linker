/** 专门管消息出站业务 */

import { API } from '../common/api.js'

/** 宿主定的封闭事件名，写错不会报错只会静默不触发。 */
const SESSION_EVENT = {
  turnEnd: 'turn/end',
}
const TURN_REASON = { completed: 'completed' }

/**
 * 出站：DSH → Java。
 *
 * 模型通过 submit_replies 工具交卷，这里在 turn/end 时把这一轮推给 Java。
 * 只发 reason.kind === 'completed' 的轮次；被中断的一轮一个字都不发。
 *
 * 推成功且 Java 回了 ack，才清掉本地出站缓存。
 */
export class Outbound {
  /**
   * @param {object} deps
   * @param {import('../linker/bridge.js').Bridge} deps.bridge
   * @param {import('../common/message_cache.js').MessageCache} deps.cache
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ bridge, cache, log }) {
    this.bridge = bridge
    this.cache = cache
    this.log = log
    /** sessionId → 本次交卷的草稿（还没到 turn/end）。 */
    this.drafts = new Map()
  }

  /** 工具交卷时调用，先攒着，等 turn/end 再统一发。 */
  submit(draft) {
    if (!draft || !draft.sessionId) return
    this.drafts.set(draft.sessionId, draft)
  }

  /** 挂到 ctx.on('session/event')。 */
  handleSessionEvent(session, event) {
    if (!event || event.type !== SESSION_EVENT.turnEnd) return
    const sessionId = String((session && session.id) || '')
    if (!sessionId) return
    void this.#finishTurn(sessionId, event.data || {})
  }

  async #finishTurn(sessionId, data) {
    const draft = this.drafts.get(sessionId)
    // 不论成败都清空，下一轮重新交卷
    this.drafts.delete(sessionId)

    const completed = Boolean(data.reason && data.reason.kind === TURN_REASON.completed)
    if (!completed || !draft || !draft.replies.length) return

    const messages = draft.replies.map((r, index) => ({
      chatType: r.chatType,
      chatId: r.chatId,
      text: r.text,
      index,
    }))

    const inbound = this.cache.inboundOfSession(sessionId)
    const archiveId = inbound.length ? String(inbound[inbound.length - 1].archiveId) : ''
    if (!archiveId) {
      this.log(`会话 …${sessionId.slice(-8)} 找不到对应的入站消息，这一轮不发`)
      return
    }

    // 先落出站池：推失败也不丢
    this.cache.putOutbound(sessionId, archiveId, messages)
    await this.push(sessionId, archiveId, messages)
  }

  /** 把出站池里这个会话的回复推给 Java；按 ack 清缓存。 */
  async push(sessionId, archiveId, messages) {
    try {
      const body = await this.bridge.post(API.push, {
        archiveId,
        sessionId,
        messages: messages.map((m) => ({
          chatType: m.chatType,
          chatId: m.chatId,
          text: m.text,
        })),
      })
      const acked = Array.isArray(body && body.data && body.data.items) ? body.data.items : []
      this.cache.ackOutbound(sessionId, acked.map((i) => i.index))
      this.log(`推回 Java ${acked.length} 条（存档 ${archiveId}）`)
    } catch (error) {
      // 推失败留在池里，下一轮重推；不在这里重试，避免重复发送
      this.log('推回 Java 失败（留在缓存待重推）：'
        + String((error && error.message) || error))
    }
  }

  dispose() {
    this.drafts.clear()
  }
}
