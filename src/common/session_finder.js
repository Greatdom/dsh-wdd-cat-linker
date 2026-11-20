/** 专门管理会话检索和匹配,以及会话归一化业务 */

import { SESSION_PREFIX, SHORT_ID_LEN } from '../common/constant.js'

/** 去掉 session- 前缀。 */
export function sessionKey(id) {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith(SESSION_PREFIX) ? s.slice(SESSION_PREFIX.length) : s
}

/** 短 id，日志用。 */
export function shortId(id) {
  return sessionKey(id).slice(-SHORT_ID_LEN)
}

/** 同一会话的两种写法，原始形态在前。 */
export function idVariants(raw) {
  return raw.startsWith(SESSION_PREFIX)
    ? [raw, raw.slice(SESSION_PREFIX.length)]
    : [raw, SESSION_PREFIX + raw]
}

/**
 * 会话查找：从 DSH 宿主拿到 agent 和会话清单。
 */
export class SessionFinder {
  /** @param {object} ctx cordis 上下文 */
  constructor(ctx) {
    this.ctx = ctx
    /** 取到的服务缓存：插件生命周期内不变。 */
    this.services = new Map()
    /**
     * 全局的 sessionId → 会话名缓存。
     */
    this.titleCache = new Map()
  }

  /** 兼容 ctx.get(name) 与 ctx[name] 两种写法。 */
  #service(name) {
    if (this.services.has(name)) return this.services.get(name)
    let value
    try {
      value = this.ctx.get?.(name)
    } catch {
      value = undefined
    }
    if (value === undefined || value === null) value = this.ctx[name]
    this.services.set(name, value)
    return value
  }

  /**
   * 全部会话，含没加载到内存的。
   *
   * @returns {Promise<Map<string, string>>} sessionId → 会话名（拿不到名字时给空串）
   */
  async getAllSessions() {
    const out = new Map()

    for (const id of this.allSessionIds()) {
      const cached = this.titleCache.get(id)
      if (cached) {
        out.set(id, cached)
        continue
      }
      const title = this.sessionTitle(id)
      if (title) this.titleCache.set(id, title)
      // 拿不到名字也照样报上去 —— 会话本身是存在的
      out.set(id, title)
    }
    return out
  }

  /**
   * **全部**会话 id（不只是有活 agent 的）。
   *
   * <p>数据来源（按可靠性排序，能拿到就合并）：
   * <ol>
   *   <li>{@code sessions.list()} —— 直接的会话清单；</li>
   *   <li>{@code workspaceRegistry.list()[].sessionIds} —— 工作区记着的会话；</li>
   *   <li>{@code agents.list()} —— 活 agent（兜底，保证不漏掉正在用的）。</li>
   * </ol>
   *
   * @returns {string[]}
   */
  allSessionIds() {
    const byKey = new Map()

    const add = (rawId) => {
      const id = String(rawId == null ? '' : rawId).trim()
      if (!id) return
      const key = sessionKey(id)
      if (!key || byKey.has(key)) return
      byKey.set(key, id)
    }

    // ① 直接的会话清单
    const sessions = this.#service('sessions')
    if (sessions && typeof sessions.list === 'function') {
      try {
        for (const s of sessions.list() || []) {
          add((s && s.id) || (s && s.sessionId))
        }
      } catch {
        // 拿不到就退到下一种来源
      }
    }

    // ② 工作区里记着的会话 —— 没打开的会话主要靠这一条
    const registry = this.#service('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      try {
        for (const ws of registry.list() || []) {
          const ids = ws && ws.sessionIds
          if (!Array.isArray(ids)) continue
          for (const id of ids) add(id)
        }
      } catch {
        // 拿不到就退到下一种来源
      }
    }

    // ③ 活 agent（兜底）
    for (const id of this.liveSessionIds()) add(id)

    return [...byKey.values()]
  }

  /** 当前有活 agent 的会话 id。 */
  liveSessionIds() {
    const agents = this.#service('agents')
    if (!agents || typeof agents.list !== 'function') return []
    try {
      return (agents.list() || [])
        .map((agent) => (agent && agent.session && agent.session.id) || (agent && agent.sessionId))
        .filter(Boolean)
        .map(String)
    } catch {
      return []
    }
  }

  /**
   * 会话显示名 —— 存档页的下拉框要用它。
   *
   * <p>取名的顺序（能拿到就用）：
   * <ol>
   *   <li>{@code sessionTitle.get({id})} —— DSH 的标题服务，最准；</li>
   *   <li>{@code sessions.get(id).title} —— 会话对象自带的标题（兜底，
   *       有些版本标题就挂在会话上而不在 title 服务里）；</li>
   *   <li>{@code agents.get(id).session.title} —— 活 agent 上带的；</li>
   * </ol>
   *
   * <p>返回空串表示「确实没有名字」，不返回占位词 ——
   * 上层要能区分「没名字」和「名字就叫这个」。
   *
   * @returns {string} 会话名；拿不到返回 ''
   */
  sessionTitle(sessionId) {
    const raw = String(sessionId == null ? '' : sessionId).trim()
    if (!raw) return ''

    // ① 标题服务
    try {
      const service = this.#service('sessionTitle')
      if (service && typeof service.get === 'function') {
        const snapshot = service.get({ id: raw })
        const title = snapshot && snapshot.title
        if (title && String(title).trim()) return String(title).trim()
      }
    } catch {
      // 退到下一种来源
    }

    // ② 会话对象自带的标题
    try {
      const sessions = this.#service('sessions')
      if (sessions && typeof sessions.get === 'function') {
        for (const id of idVariants(raw)) {
          const s = sessions.get(id)
          if (s) {
            const title = s.title || s.name
            if (title && String(title).trim()) return String(title).trim()
          }
        }
      }
    } catch {
      // 退到下一种来源
    }

    // ③ 活 agent 上带的
    const agent = this.findAgent(raw)
    const fromAgent = agent && agent.session && agent.session.title
    if (fromAgent && String(fromAgent).trim()) return String(fromAgent).trim()

    return ''
  }

  /** 只查内存里的 agent，两种 id 写法都试。**不触发恢复。** */
  findAgent(sessionId) {
    const raw = String(sessionId == null ? '' : sessionId).trim()
    if (!raw) return undefined
    const agents = this.#service('agents')
    if (!agents || typeof agents.get !== 'function') return undefined

    for (const id of idVariants(raw)) {
      try {
        const agent = agents.get(id)
        if (agent !== undefined && agent !== null) return agent
      } catch {
        // 换下一种写法
      }
    }
    return undefined
  }

  /**
   * 拿 agent；内存里没有就从磁盘恢复。
   *
   * 走 sessionController.agents.resolveAgent()，不是 agents.resume() ——
   * 后者需要 agentOptions + setup 闭包，只有 session-controller 内部拿得到。
   */
  async resumeAgent(sessionId) {
    const raw = String(sessionId == null ? '' : sessionId).trim()
    if (!raw) return undefined

    const cached = this.findAgent(raw)
    if (cached) return cached

    const controller = this.#service('sessionController')
    const resolver = controller && controller.agents
    if (!resolver || typeof resolver.resolveAgent !== 'function') return undefined

    try {
      const found = await resolver.resolveAgent(raw)
      if (found && !found.error && found.agent) return found.agent
    } catch {
      // 会话不存在、已归档、或恢复失败，一律当作拿不到
    }
    return undefined
  }
}
