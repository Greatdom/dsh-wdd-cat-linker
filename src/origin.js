/**
 * 轮次来源：记住「这一轮是哪个存档、哪个聊天、哪个通道触发的」。
 *
 * ---- 解决什么问题 ----
 *
 *  ① **广播** —— 早期出站按会话反查全部绑定，私聊和群绑同一会话时会同时发两处；
 *  ② **手动说话外发** —— 在 DSH 里手敲的话不该发到 QQ；
 *  ③ **发错平台** —— 存档制度下要明确「这轮回复该用哪个存档的身份、发回哪个通道」。
 *
 * 共同判据是「这轮有没有来源」：
 *   有 → 发回那个聊天、用那个存档的身份；没有 → 手动触发，不往外发。
 *
 * ---- 改了什么 ----
 *
 * 原来记的是一个字符串 `chatKey`；现在记一个对象 `{ archiveId, chatKey, channel }`。
 * 因为出站时 Java 需要三样东西才知道「用哪个号、发到哪个聊天、走哪个渠道」。
 *
 * ⚠ 目前只做「有无」判断，没有时效。
 *   一条 QQ 消息投递几分钟后再手动说话，仍会被算作那一条的回复。时效是拓展点。
 */

import { CHANNEL_QQ } from './config.js'
import { SESSION_ORIGIN_LIMIT } from './constants.js'

export class TurnOrigin {
  constructor(limit = SESSION_ORIGIN_LIMIT) {
    /** 会话键 → 来源对象。Map 保插入顺序，用于 FIFO 淘汰。 */
    this.bySession = new Map()
    this.limit = limit
  }

  /**
   * 入站投递成功时记一笔。
   *
   * @param {string} sessionId 会话
   * @param {{archiveId: string, chatKey: string, channel?: string}|string} source
   *        来源对象；传字符串时按「只有 chatKey」处理（兼容旧调用）
   */
  remember(sessionId, source) {
    const key = String(sessionId || '')
    if (!key) return

    const normalized = typeof source === 'string'
      ? { archiveId: '', chatKey: String(source || ''), channel: CHANNEL_QQ }
      : {
          archiveId: String((source && source.archiveId) || ''),
          chatKey: String((source && source.chatKey) || ''),
          channel: String((source && source.channel) || CHANNEL_QQ),
        }

    // 没有 chatKey 就没有意义
    if (!normalized.chatKey) return

    // 重新插到末尾，让「最近用过的」排在后面，不被先淘汰
    this.bySession.delete(key)
    this.bySession.set(key, normalized)

    while (this.bySession.size > this.limit) {
      const oldest = this.bySession.keys().next().value
      if (oldest === undefined) break
      this.bySession.delete(oldest)
    }
  }

  /**
   * 取来源。
   *
   * @returns {{archiveId: string, chatKey: string, channel: string}|null}
   *          没有说明这轮不是外部触发的（手动说话）
   */
  of(sessionId) {
    return this.bySession.get(String(sessionId || '')) || null
  }

  /** 一轮回复已经处理完，清掉来源——避免下一条手动消息误用旧来源。 */
  consume(sessionId) {
    this.bySession.delete(String(sessionId || ''))
  }

  clear() {
    this.bySession.clear()
  }
}
