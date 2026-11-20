/** 专门管消息入站业务 */

import { API } from '../common/api.js'
import { INBOUND_MARK, INBOUND_SUFFIX } from '../common/constant.js'
import { shortId } from '../common/session_finder.js'
import { plainText, summarize } from '../common/media.js'

/**
 * 入站：Java → DSH。
 *
 * 一轮做这些：
 *   1. 按自己报的会话清单去 Java 取；
 *   2. **取到就立刻 ack**（用户定的语义：跳板只要成功拿到消息就 ack，
 *      ack 之后才判断会话在不在，不在就自行丢弃）；
 *   3. 按 sessionId 恢复 DSH 会话并 followup。
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
        await this.#deliver(message)
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
    } catch (error) {
      this.log('ack 失败：' + String((error && error.message) || error))
    }
  }

  /** 投给一个会话。会话不存在就丢弃。 */
  async #deliver(message) {
    const sessionId = String((message && message.sessionId) || '')
    if (!sessionId) {
      this.log('消息没有 sessionId，丢弃')
      return
    }

    const agent = await this.finder.resumeAgent(sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      this.log(`会话 …${shortId(sessionId)} 打不开，丢弃这条消息`)
      return
    }

    const text = plainText(message.content)
    if (!text) {
      this.log('消息正文为空，跳过')
      return
    }

    // 正文里带上来源，模型才知道这轮该用 submit_replies 回出去，
    // 而不是当成界面上的闲聊。前缀也是无状态上下文识别外部消息的依据。
    const prompt = `${INBOUND_MARK}${message.chatType === 'group' ? '群聊' : '私聊'}`
      + ` ${message.chatId}，发送者 ${message.senderName || message.senderId || '未知'}：\n`
      + `${text}\n\n${INBOUND_SUFFIX}`

    await agent.followup({
      // id 带上存档后缀：同一条消息投给多个存档时不会撞
      //TODO 不一定是qq-开头,因为以后会接入多渠道消息
      id: `qq-${message.channelMessageId}-${message.archiveId}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      // source.kind 是封闭枚举，没有 'qq'；用 'user' 让 UI 当人话渲染
      source: { kind: 'user' },
    })

    // 投进去了才标记：这一轮等着被回复
    this.cache.markPending(message)

    this.log(`收到 ${message.chatType}:${message.chatId} → 会话 …${shortId(sessionId)}：`
      + summarize(text))
  }

  dispose() {
    this.stopped = true
  }
}
