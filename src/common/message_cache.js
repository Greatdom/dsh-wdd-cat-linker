/**
 * 出入站消息缓冲池
 *
 * 三个池：
 *   入站成功但尚未ack的消息缓存
 *   入站消息缓存
 *   出站消息缓存
 */
export class MessageCache {
  constructor() {
    /** 入站成功但尚未ack的消息缓存 */
    this.inbound = new Map()
    /** 入站消息缓存 */
    this.pending = new Map()
    /** 出站消息缓存 */
    this.outbound = []
  }

  /** 入站成功但尚未ack的消息缓存的缓存键。 */
  static inboundKey(message) {
    return `${message.archiveId}:${message.channelMessageId}`
  }

  putInbound(message) {
    if (!message || !message.channelMessageId) return
    this.inbound.set(MessageCache.inboundKey(message), message)
  }

  deleteInbound(message){
    if (!message || !message.channelMessageId) return
    this.inbound.delete(MessageCache.inboundKey(message), message)
  }

  markPending(message) {
    if (!message || !message.sessionId) return
    this.pending.set(message.sessionId, message)
  }

  takePending(sessionId) {
    const message = this.pending.get(sessionId)
    if (message) this.pending.delete(sessionId)
    return message
  }

  peekPending(sessionId) {
    return this.pending.get(sessionId)
  }

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

  /**@deprecated 废方法 推失败时整批丢掉  */
  clearOutbound() {
    this.outbound = []
  }

  /** @deprecated 废方法 */
  outboundSize() {
    return this.outbound.length
  }

  /** @deprecated 废方法 */
  inboundOfSession(sessionId) {
    const out = []
    for (const message of this.inbound.values()) {
      if (message.sessionId === sessionId) out.push(message)
    }
    return out
  }

    /** @deprecated 废方法 */
  dropInbound(sessionId) {
    for (const [key, message] of this.inbound) {
      if (message.sessionId === sessionId) this.inbound.delete(key)
    }
    this.pending.delete(sessionId)
  }

    /** @deprecated 废方法 */
  inboundSize() {
    return this.inbound.size
  }

}
