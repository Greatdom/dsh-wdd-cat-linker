/** 专门管消息出站业务 */

import { API } from '../common/api.js'
import { plainText } from '../common/media.js'

/** 宿主定的封闭事件名，写错不会报错只会静默不触发。 */
const SESSION_EVENT = {
  turnEnd: 'turn/end',
}
const TURN_REASON = { completed: 'completed' }

/**
 * 出站：DSH → cat 服务器。
 * 模型通过 submit_replies 工具交卷，这里在 turn/end 时把这一轮推给 cat 服务器。
 * 推成功且 cat 回了 ack，才清掉本地出站缓存。
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
    /** sessionId → 本次交卷的草稿 */
    this.drafts = new Map()
  }

  /** 工具交卷回调函数。 */
  submit(draft) {
    if (!draft || !draft.sessionId) return
    this.log(`交卷 ${draft.replies.length} 条（会话 …${draft.sessionId.slice(-8)}）`)
    this.drafts.set(draft.sessionId, draft)
  }

  /** 出站核心方法 */
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
    this.drafts.delete(sessionId)

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

    // 这一轮是不是外部消息触发的判断
    const origin = this.cache.takePending(sessionId)
    if (!origin) {
      this.log(`会话 …${sessionId.slice(-8)} 这一轮由界面直接触发，不发到外部`)
      return
    }

      // 模型出站消息的相关信息没填就复用入站消息的信息
    const archiveId = String(origin.archiveId || '')
    const messages = draft.replies.map((r, index) => ({
      chatType: r.chatType || origin.chatType || '',
      chatId: r.chatId || origin.chatId || '',
      text: r.text,
      index,
    }))

    this.cache.putOutbound(sessionId, archiveId, messages, origin)
    await this.push(sessionId, archiveId, messages, origin)
  }

  /**
   * 把这一轮的回复推给 cat 服务器。一轮一个 ack：
   * 收到 ack（记得带上 sessionId）就整轮删掉，没收到就标 FAILED 等定时器清理。
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
          text: plainText(origin.content),
        },
        messages: messages.map((m) => ({
          chatType: m.chatType,
          chatId: m.chatId,
          text: m.text,
        })),
      })

      // 服务器只在「整轮收下了」时才回 ack；带了别的 sessionId 一律不认
      const ackedSessionId = String((body && body.data && body.data.sessionId) || '')
      if (ackedSessionId && ackedSessionId === String(sessionId)) {
        this.cache.deleteOutbound(sessionId)
        this.log(`推回 cat ${messages.length} 条（存档 ${archiveId}）`)
        return true
      }

      // 没拿到对应 ack：留着，按失败处理
      this.cache.markOutboundFailed(sessionId)
      this.log(`推回 cat 没拿到 ack（存档 ${archiveId}），标记待清理`)
      return false
    } catch (error) {
      // 推失败留在出站池，由定时器按 outboundFailTtlMs 清掉（暂时不做重推）
      this.cache.markOutboundFailed(sessionId)
      this.log('推回 cat 失败（留在出站池待清理）：'
        + String((error && error.message) || error))
      return false
    }
  }

  /**
   * 定期清掉冷却期已过的失败记录。
   *
   * 这是「推失败之后怎么办」的当前答案：先留着，过了 outboundFailTtlMs 就丢。
   * 重推逻辑还没做，所以这里只清理不重发。
   *
   * @param {number} ttlMs 失败后留多久
   */
  sweepFailed(ttlMs) {
    const dropped = this.cache.sweepFailedOutbound(ttlMs)
    for (const entry of dropped) {
      this.log(`丢弃推送失败的一轮出站消息（会话 …${String(entry.sessionId).slice(-8)}，`
        + `${entry.messages.length} 条）`)
    }
    return dropped.length
  }

  dispose() {
    this.drafts.clear()
  }
}
