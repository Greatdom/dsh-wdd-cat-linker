/**
 * 出入站消息缓冲池
 *
 * 三个池，**全部按 sessionId 分桶** —— 一个 DSH 会话一个槽位：
 *
 *   inbound   入站拿到、还没被 ack 掉的消息     Map<sessionId, 完整入站消息对象>
 *   pending   投进 DSH 了、这一轮等着被回复的消息 Map<sessionId, 完整入站消息对象>
 *   outbound  模型交了卷、等着推回 cat 的回复     Map<sessionId, 整轮记录>
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
    /** 已交卷、等推回 cat 的回复：sessionId → 整轮（一轮一条，跟着一轮一个 ack） */
    this.outbound = new Map()
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
  //
  // 一个会话一轮只存一条整轮记录，状态三态：
  //   FLYING  正在推给 cat，等它回 ack
  //   FAILED  推失败（或没拿到 ack），留着等清理定时器处理
  // 成功时直接删掉，不需要第三个状态。

  /**
   * 记下一轮出站消息。
   *
   * @param {string} sessionId 哪个会话
   * @param {string} archiveId 哪个存档
   * @param {Array<{chatType: string, chatId: string, text: string, index: number}>} messages
   * @param {object} origin 触发这一轮的入站消息（重推时靠它决定发去哪）
   */
  putOutbound(sessionId, archiveId, messages, origin) {
    const key = String(sessionId)
    this.outbound.set(key, {
      sessionId: key,
      archiveId,
      origin,
      messages: (Array.isArray(messages) ? messages : []).map((m) => ({ ...m })),
      status: OutboundStatus.FLYING,
      updatedAt: Date.now(),
    })
  }

  /** 当前出站池（调试/排障看）。 */
  peekOutbound() {
    return this.outbound
  }

  /** 看一个会话的出站记录，不删。 */
  peekOutboundOf(sessionId) {
    return this.outbound.get(String(sessionId))
  }

  /** 推成功：整轮删掉。 */
  deleteOutbound(sessionId) {
    this.outbound.delete(String(sessionId))
  }

  /** 推失败：标成 FAILED 并刷新时间，等定时器按 ttl 清理。 */
  markOutboundFailed(sessionId) {
    const key = String(sessionId)
    const entry = this.outbound.get(key)
    if (!entry) return
    entry.status = OutboundStatus.FAILED
    entry.updatedAt = Date.now()
  }

  /**
   * 清掉冷却期已过的 FAILED 记录。
   *
   * @param {number} ttlMs 失败之后留多久
   * @param {number} [now] 当前时间（测试可注入）
   * @returns {Array<object>} 被清掉的记录，调用方拿去打日志
   */
  sweepFailedOutbound(ttlMs, now = Date.now()) {
    const dropped = []
    for (const [key, entry] of this.outbound) {
      if (entry.status !== OutboundStatus.FAILED) continue
      if (now - entry.updatedAt < ttlMs) continue
      this.outbound.delete(key)
      dropped.push(entry)
    }
    return dropped
  }

  /** 当前出站池里几轮。 */
  outboundSize() {
    return this.outbound.size
  }
}

/** 出站记录的状态。 */
export const OutboundStatus = Object.freeze({
  /** 正在推给 cat 服务器，等 ack */
  FLYING: 'FLYING',
  /** 推失败 / 没拿到 ack，留着等清理 */
  FAILED: 'FAILED',
})
