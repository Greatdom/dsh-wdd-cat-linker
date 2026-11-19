/** 出入站消息缓冲池 */
/** 和中转站的约定:每次从InboundMessageController拉到的信息,数量是'每个跳板持有会话上限只有一个'的总和;一个存档当前时间唯一绑定一个存档 */
/** 文件维护一个容器存储来到站内的信息,得到回复后从消息缓存得到入站池,有利于正确组装出站消息 */
/** 消息出站前将消息存到出站池并和入站池的特定消息组装成真正的OutboundMessage */

/**
 * 消息缓存池。
 *
 * 两个池：
 *   · 入站池 —— 从 Java 拉到的消息。**先落池再发 DSH**，发不出去也不会丢。
 *   · 出站池 —— 模型交卷的回复。**收到 Java 的 ack 才清**，没被 ack 的留着下轮重推。
 *
 * 入站池按 archiveId 反查，出站时拿去和回复组装成完整的一条。
 */
export class MessageCache {
  constructor() {
    /** inboundId → 入站消息。键用 archiveId + channelMessageId。 */
    this.inbound = new Map()
    /** 出站待推队列，保持投递顺序。 */
    this.outbound = []
  }

  /** 入站消息的缓存键。 */
  static inboundKey(message) {
    return `${message.archiveId}:${message.channelMessageId}`
  }

  // ── 入站池 ──

  /** 拉到的消息先落池。重复拉到同一条只留一份。 */
  putInbound(message) {
    if (!message || !message.channelMessageId) return
    this.inbound.set(MessageCache.inboundKey(message), message)
  }

  /** 按会话取这个会话最近的入站消息，出站组装时用。 */
  inboundOfSession(sessionId) {
    const out = []
    for (const message of this.inbound.values()) {
      if (message.sessionId === sessionId) out.push(message)
    }
    return out
  }

  /** 一轮回复已经推出去了，把对应的入站清掉。 */
  dropInbound(sessionId) {
    for (const [key, message] of this.inbound) {
      if (message.sessionId === sessionId) this.inbound.delete(key)
    }
  }

  inboundSize() {
    return this.inbound.size
  }

  // ── 出站池 ──

  /**
   * 模型交卷：按条进池，等推到 Java。
   *
   * 一条一条存而不是整批存 —— ack 是按 index 逐条确认的，
   * 整批存就没法只清掉被确认的那部分。
   */
  putOutbound(sessionId, archiveId, messages) {
    for (const m of Array.isArray(messages) ? messages : []) {
      this.outbound.push({ sessionId, archiveId, index: m.index, ...m })
    }
  }

  /** 当前待推的全部（不删）。 */
  peekOutbound() {
    return this.outbound
  }

  /**
   * 按 ack 清掉已确认的。
   *
   * @param {string} sessionId 哪个会话
   * @param {number[]} indexes Java 确认收到的下标
   */
  ackOutbound(sessionId, indexes) {
    const drop = new Set(indexes)
    this.outbound = this.outbound
      .filter((item) => !(item.sessionId === sessionId && drop.has(item.index)))
  }

  /** 推失败时整批丢掉，交给下一轮从 DSH 重新交卷。 */
  clearOutbound() {
    this.outbound = []
  }

  outboundSize() {
    return this.outbound.length
  }
}
