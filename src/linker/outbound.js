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
    this.log(`交卷 ${draft.replies.length} 条（会话 …${draft.sessionId.slice(-8)}）`)
    this.drafts.set(draft.sessionId, draft)
  }

  /** 挂到 ctx.on('session/event')。 */
  handleSessionEvent(session, event) {
    if (!event || event.type !== SESSION_EVENT.turnEnd) return
    // 会话 id 三种写法都试：session.id / session.sessionId / 事件里带的
    const sessionId = String(
      (session && (session.id || session.sessionId)) || ''
    ).trim()
    if (!sessionId) return
    void this.#finishTurn(sessionId, event.data || {})
  }

  async #finishTurn(sessionId, data) {
    const draft = this.drafts.get(sessionId)
    // 不论成败都清空，下一轮重新交卷
    this.drafts.delete(sessionId)

    // reason 可能在 data 里，也可能直接挂在事件上，两种都认
    const reason = (data && data.reason) || data
    const completed = Boolean(reason && reason.kind === TURN_REASON.completed)
    if (!completed) {
      this.log(`会话 …${sessionId.slice(-8)} 这一轮没正常完成（reason=${reason && reason.kind}），不发`)
      return
    }
    if (!draft || !draft.replies.length) {
      this.log(`会话 …${sessionId.slice(-8)} 这一轮没有交卷内容，不发`)
      return
    }

    // 这一轮是不是外部消息触发的：没有 pending 就是用户直接聊天，一个字都不发。
    // takePending 取一次就没，所以一轮只对应一条入站消息。
    const origin = this.cache.takePending(sessionId)
    if (!origin) {
      this.log(`会话 …${sessionId.slice(-8)} 这一轮由界面直接触发，不发到外部`)
      return
    }

    const archiveId = String(origin.archiveId || '')
    const messages = draft.replies.map((r, index) => ({
      // 模型没填就沿用收到的消息
      chatType: r.chatType || origin.chatType || '',
      chatId: r.chatId || origin.chatId || '',
      text: r.text,
      index,
    }))

    // 先落出站池：推失败也不丢
    this.cache.putOutbound(sessionId, archiveId, messages, origin)
    await this.push(sessionId, archiveId, messages, origin)
  }

  /**
   * 把出站池里这个会话的回复推给 Java；按 ack 清缓存。
   *
   * @param {object} origin 这一轮在回的那条入站消息 —— Java 靠它决定渠道和目标。
   *   只带身份字段：assessment / recallBundle / egoDecision 是 Java 算的，
   *   带回去既没用还会撞上复杂类型反序列化。
   */
  async push(sessionId, archiveId, messages, origin) {
    try {
      const body = await this.bridge.post(API.push, {
        archiveId,
        sessionId,
        inbound: {
          archiveId: String(origin.archiveId || ''),
          sessionId: String(origin.sessionId || ''),
          channel: String(origin.channel || ''),
          chatType: String(origin.chatType || ''),
          chatId: String(origin.chatId || ''),
          senderId: String(origin.senderId || ''),
          senderName: String(origin.senderName || ''),
          card: String(origin.card || ''),
          senderKind: String(origin.senderKind || ''),
          channelMessageId: String(origin.channelMessageId || ''),
          timestamp: Number(origin.timestamp) || 0,
        },
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
