/**
 * 工作区：清单、归档名单、挑会话、路径根。
 *
 * 这些查询都建立在 DSH 的 `workspaceRegistry` 之上，彼此共享
 * 「归档集合 + 活会话集合」这两样数据，所以放在一起。
 *
 * 与 resolver.js 的分工：
 *   · 这里回答「这个工作区里哪间会话最近活跃」——纯查询，不碰 agent 生命周期；
 *   · resolver 回答「这条绑定落到哪间会话、它的 agent 在不在」。
 */

import { SHORT_ID_LEN } from './constants.js'
import { sessionKey } from './session-id.js'

export class WorkspaceIndex {
  /**
   * @param {object} deps
   * @param {object} deps.ctx            cordis 上下文
   * @param {Function} deps.service      (name) => 服务实例，由 SessionResolver 提供
   * @param {Function} deps.findAgent    (sessionId) => agent|undefined，只查内存
   * @param {Function} deps.liveSessionIds () => string[]，当前有活 agent 的会话
   */
  constructor({ ctx, service, findAgent, liveSessionIds }) {
    this.ctx = ctx
    this.service = service
    this.findAgent = findAgent
    this.liveSessionIds = liveSessionIds || (() => [])
  }

  /** 全部工作区（字段已规整）。 */
  list() {
    const registry = this.service('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return []
    try {
      return (registry.list() || []).map((ws) => ({
        id: String(ws.id || ''),
        title: String(ws.title || ''),
        path: String(ws.path || ''),
        sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds.map(String) : [],
      }))
    } catch {
      return []
    }
  }

  /** 按 id 取一个工作区（原始形态）。 */
  get(workspaceId) {
    const registry = this.service('workspaceRegistry')
    if (!registry || typeof registry.get !== 'function') return null
    try {
      return registry.get(workspaceId) || null
    } catch {
      return null
    }
  }

  /** 已归档的会话键集合。`archivedSessionIds` 在 DSH 里是方法不是属性。 */
  archivedKeys() {
    const out = new Set()
    const registry = this.service('workspaceRegistry')
    if (!registry) return out
    try {
      const value = typeof registry.archivedSessionIds === 'function'
        ? registry.archivedSessionIds()
        : registry.archivedSessionIds
      for (const id of value || []) out.add(sessionKey(id))
    } catch {
      // 拿不到就当没有归档
    }
    return out
  }

  /**
   * 一次取齐「归档集合 + 活会话集合」。
   *
   * 挑会话要反复用到这两样，放外层算一次，
   * 避免 O(绑定数 × 会话数) 的重复遍历。
   */
  snapshot(liveSessionIds) {
    return {
      archived: this.archivedKeys(),
      live: new Set((liveSessionIds || []).map(sessionKey)),
    }
  }

  /**
   * 在工作区里挑一间会话。只做内存判断，不恢复。
   *
   * @param {string} workspaceId
   * @param {'recent'|'first'} pick
   * @param {{archived: Set<string>, live: Set<string>, liveIds?: string[]}} [snapshot]
   *        复用外层快照；不传则自己现算一次（批量调用时应传，避免重复遍历）
   * @returns {{sessionId: string, reason: string}|null}
   */
  pickSession(workspaceId, pick = 'recent', snapshot) {
    const workspace = this.get(workspaceId)
    if (!workspace) return null

    // 不传快照时现算；liveIds 由调用方通过 snapshot 传入，缺省则认为没有活会话
    const { archived, live } = snapshot || {
      archived: this.archivedKeys(),
      live: new Set(this.liveSessionIds()),
    }
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : []

    let candidates = sessionIds
      .filter((id) => !archived.has(sessionKey(id)))
      .filter((id) => live.has(sessionKey(id)))

    if (!candidates.length) {
      // 退一步：有些工作区的 sessionIds 还没同步，只要有活 agent 就收
      candidates = sessionIds.filter((id) => this.findAgent(id))
    }
    if (!candidates.length) return null

    if (pick === 'first') {
      return { sessionId: candidates[0], reason: 'workspace:first' }
    }
    return { sessionId: this.#mostRecent(candidates), reason: 'workspace:recent' }
  }

  /** 解析相对路径的根目录：会话所在工作区优先，再退到进程当前目录。 */
  rootsForSession(sessionId) {
    const roots = []
    try {
      const key = sessionKey(sessionId)
      for (const ws of this.list()) {
        if (ws.sessionIds.some((id) => sessionKey(id) === key)) {
          if (ws.path) roots.push(ws.path)
          break
        }
      }
    } catch {
      // ignore
    }
    if (typeof process !== 'undefined' && process.cwd) roots.push(process.cwd())
    return roots
  }

  /** 最近有活动的那间；拿不到活动时间就按顺序取最后（越靠后一般越新）。 */
  #mostRecent(candidates) {
    const sessions = this.service('sessions')
    const activityOf = (id) => {
      try {
        if (sessions && typeof sessions.get === 'function') {
          const s = sessions.get(id) || sessions.get(sessionKey(id))
          if (s) {
            const stamp = s.updatedAt || s.lastActivityAt || s.lastActivity || 0
            if (typeof stamp === 'number' && stamp > 0) return stamp
            if (stamp instanceof Date) return stamp.getTime()
          }
        }
      } catch {
        // ignore
      }
      return 0
    }

    const scored = candidates.map((id, index) => ({ id, index, at: activityOf(id) }))
    scored.sort((a, b) => (b.at !== a.at ? b.at - a.at : b.index - a.index))
    return scored[0].id
  }

  /** 工作区 id 的短写，用于日志。 */
  shortId(workspaceId) {
    return String(workspaceId || '').slice(-SHORT_ID_LEN)
  }
}
