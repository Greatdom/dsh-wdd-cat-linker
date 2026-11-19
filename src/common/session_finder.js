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
 * 会话查找：从 DSH 宿主拿到 agent。
 *
 * 为什么必须在 JS 侧：只有 DSH 知道哪间会话有活 agent、哪些已归档。
 * Java 只接收结论（sessionId 清单），不知道这些。
 */
export class SessionFinder {
  /** @param {object} ctx cordis 上下文 */
  constructor(ctx) {
    this.ctx = ctx
    /** 取到的服务缓存：插件生命周期内不变。 */
    this.services = new Map()
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

  /** 当前有活 agent 的会话 id。心跳报的就是这个清单。 */
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

  /** 只查内存里的 agent，两种 id 写法都试。不触发恢复。 */
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
