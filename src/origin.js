/**
 * 轮次来源：记住「这一轮是哪个 QQ 聊天触发的」。
 *
 * 解决两个问题：
 *   ① **广播** —— 之前出站按会话反查全部绑定，私聊和群绑同一会话时会同时发两处；
 *   ② **手动说话外发** —— 你在 DSH 里手敲的话不该发到 QQ。
 *
 * 两者的共同判据是「这轮有没有 QQ 来源」：
 *   有 → 只回给那个聊天；没有 → 说明是手动触发的，不往外发。
 *
 * ⚠ 目前只做「有无」判断，没有时效。
 *   你说的「几分钟前的 QQ 消息不该被当成来源」是拓展点，还没做。
 *   在那之前，一条 QQ 消息投递之后再手动说话，仍会被算作那一条的回复。
 */

import { SESSION_ORIGIN_LIMIT } from './constants.js'

export class TurnOrigin {
  constructor(limit = SESSION_ORIGIN_LIMIT) {
    /** 会话键 → chatKey。Map 保插入顺序，用于 FIFO 淘汰。 */
    this.bySession = new Map()
    this.limit = limit
  }

  /** 入站投递成功时记一笔。 */
  remember(sessionId, chatKey) {
    const key = String(sessionId || '')
    const chat = String(chatKey || '')
    if (!key || !chat) return

    // 重新插到末尾，让「最近用过的」排在后面，不被先淘汰
    this.bySession.delete(key)
    this.bySession.set(key, chat)

    while (this.bySession.size > this.limit) {
      const oldest = this.bySession.keys().next().value
      if (oldest === undefined) break
      this.bySession.delete(oldest)
    }
  }

  /** 取来源聊天；没有说明这轮不是 QQ 触发的（手动说话）。 */
  of(sessionId) {
    return this.bySession.get(String(sessionId || '')) || ''
  }

  /** 一轮回复已经处理完，清掉来源——避免下一条手动消息误用旧来源。 */
  consume(sessionId) {
    this.bySession.delete(String(sessionId || ''))
  }

  clear() {
    this.bySession.clear()
  }
}
