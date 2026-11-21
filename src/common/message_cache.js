/**
 * 出入站消息缓冲池
 *
 * 三个池，**全部按 sessionId 分桶** —— 一个 DSH 会话一个槽位：
 *
 *   inbound   入站拿到、还没被 ack 掉的消息     Map<sessionId, 完整入站消息对象>
 *   pending   投进 DSH 了、这一轮等着被回复的消息 Map<sessionId, 完整入站消息对象>
 *   outbound  模型交了卷、等着推回 cat 的回复     （A2 会改成按会话存）
 *
 * 为什么按会话分桶而不是按消息号：这个缓存的存在意义是「某个会话现在卡在哪一步」，
 * 按消息号散着存的话，回答「这个会话有没有待处理的东西」每次都要全表扫。
 */

export class MessageCache {
  constructor() {
    /** 入站拿到、尚未 ack 的消息：sessionId → 消息 */
    this.inbound = new Map()
    /** 已投进 DSH、等这一轮回复的消息：sessionId → 消息 */
    this.pending = new Map()
    /** 已交卷、等推回 cat 的回复 */
    this.outbound = []
  }

  // ── 入站池 ──────────────────────────────────────────────

  /**
   * 记一条入站消息。
   *
   * sessionId 是桶键；没有 sessionId 的消息无处可放（inbound.js 在拉取阶段
   * 就已经丢弃这类消息），这里直接忽略。
   */
  putInbound(message) {
    const sessionId = message && message.sessionId
    if (!sessionId || !message.channelMessageId) return
    this.inbound.set(String(sessionId), message)
  }

  /** ack 成功后清掉这个会话的入站缓存。 */
  deleteInbound(message) {
    const sessionId = message && message.sessionId
    if (!sessionId || !message.channelMessageId) return
    this.inbound.delete(String(sessionId))
  }

  /** 这个会话有没有还没 ack 的入站消息。 */
  hasInbound(sessionId) {
    return this.inbound.has(String(sessionId))
  }

  /** 看一眼这个会话的入站缓存，不删。 */
  peekInbound(sessionId) {
    return this.inbound.get(String(sessionId))
  }

  /** 当前有几个会话还压着入站消息。 */
  inboundSize() {
    return this.inbound.size
  }

  // ── 待应答池 ────────────────────────────────────────────

  /** 投进 DSH 之后标记：这一轮等着被回复。 */
  markPending(message) {
    if (!message || !message.sessionId) return
    this.pending.set(String(message.sessionId), message)
  }

  /** 取出并清掉（一轮结束时用，防止同一轮被重复当成「外部触发」）。 */
  takePending(sessionId) {
    const key = String(sessionId)
    const message = this.pending.get(key)
    if (message) this.pending.delete(key)
    return message
  }

  /** 只看不取（判断「这一轮是不是外部触发的」）。 */
  peekPending(sessionId) {
    return this.pending.get(String(sessionId))
  }

  /** 当前有几个会话在等回复。 */
  pendingSize() {
    return this.pending.size
  }

  // ── 出站池 ──────────────────────────────────────────────

  putOutbound(sessionId, archiveId, messages, origin) {
    for (const m of Array.isArray(messages) ? messages : []) {
      // origin 一起存：推失败要重推时还得靠它决定发去哪
      this.outbound.push({ sessionId, archiveId, origin, index: m.index, ...m })
    }
  }

  peekOutbound() {
    return this.outbound
  }

  /**
   * 按 ack 清掉已确认的,推失败时留着
   */
  ackOutbound(sessionId, indexes) {
    const drop = new Set(indexes)
    this.outbound = this.outbound
      .filter((item) => !(item.sessionId === sessionId && drop.has(item.index)))
  }
}
