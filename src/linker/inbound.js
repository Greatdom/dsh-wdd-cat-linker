/** 专门管消息入站业务 */

import { API } from '../common/api.js'
import { deliver } from '../utils/deliver.js'

/**
 * 入站：cat 服务器 → DSH。
 *
 * 一轮做这些：
 *   1. 按自己报的会话清单去 cat 服务器取；
 *   2. **取到就立刻 ack**（拿到就算投递成功，后面会话在不在另说）；
 *   3. 逐条交给 {@link deliver} 投进 DSH 会话。
 *
 * 这里只负责搬运。拼提示词、恢复会话、followup 都在 utils/deliver.js。
 */
export class Inbound {
  /**
   * @param {object} deps
   * @param {import('../linker/bridge.js').Bridge} deps.bridge
   * @param {import('../common/session_finder.js').SessionFinder} deps.finder
   * @param {import('../common/message_cache.js').MessageCache} deps.cache
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ bridge, finder, cache, log }) {
    this.bridge = bridge
    this.finder = finder
    this.cache = cache
    this.log = log
    /** 正在跑的一轮（single-flight，防止同一批消息被投两次）。 */
    this.running = null
    this.stopped = false
    /** 还记得的可用会话，避免每轮重算。 */
    this.sessionIds = []

    /** deliver 需要的那几样，构造一次复用。 */
    this.deliverDeps = { finder, cache, log }
  }

  /** 让 inbound 知道当前该向哪些会话取。心跳那边算出来就传进来。 */
  setSessionIds(sessionIds) {
    this.sessionIds = Array.isArray(sessionIds) ? sessionIds : []
  }

  /** 轮询入口。上一轮没跑完就复用它的 Promise。 */
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.#run()
      .catch((error) => {
        this.log('入站轮询出错：' + String((error && error.message) || error))
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  async #run() {
    if (!this.sessionIds.length) return

    const body = await this.bridge.get(API.get(this.sessionIds))
    const messages = Array.isArray(body && body.data && body.data.messages)
      ? body.data.messages
      : []
    if (!messages.length) return

    // 先落池再发：发不出去也不会丢
    for (const message of messages) {
      this.cache.putInbound(message)
    }

    // 再 ack：拿到就算投递成功，后面会话在不在另说
    await this.#ack(messages)

    for (const message of messages) {
      if (this.stopped) break
      try {
        await deliver(this.deliverDeps, message)
      } catch (error) {
        this.log(`投递 ${message && message.channelMessageId} 出错：`
          + String((error && error.message) || error))
      }
    }
  }

  /** 一次性把这一批全 ack 掉。 */
  async #ack(messages) {
    const items = messages.map((m) => ({
      archiveId: m.archiveId,
      sessionId: m.sessionId,
      channelMessageId: m.channelMessageId,
      chatKey: `${m.channel}:${m.chatType}:${m.chatId}`,
      timestamp: m.timestamp,
    }))
    try {
      await this.bridge.post(API.ack, { items })

      for (const message of messages) {
        this.cache.deleteInbound(message)
      }

    } catch (error) {
      this.log('ack 失败：' + String((error && error.message) || error))
    }
  }

  dispose() {
    this.stopped = true
  }
}
