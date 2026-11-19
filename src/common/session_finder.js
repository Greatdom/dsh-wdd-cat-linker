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
    /**
     * 全局的 sessionId → 会话名缓存。
     *
     * 拿到一次名字就不再 resume —— 没活 agent 的会话每次 resume 都是真读盘。
     * 按约定永久缓存，会话改名后这里不跟进，要等插件重启。
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
   * 与「有活 agent 的会话」不同：DSH 的 agent 按需创建、用完回收，
   * agents.list() 只返回内存里挂着的那些。心跳要报的是「存在」而不是「现在活着」。
   *
   * 名字走 titleCache，拿到一次就不再 resume。
   * 拿不到名字的会话不缓存 —— 否则一次临时打不开会被永久当成「没名字」。
   *
   * @returns {Promise<Map<string, string>>} sessionId → 会话名（拿不到名字时给空串）
   */
  async getAllSessions() {
    const out = new Map()

    for (const sessionId of this.#candidateSessionIds()) {
      const cached = this.titleCache.get(sessionId)
      if (cached !== undefined) {
        out.set(sessionId, cached)
        continue
      }
      const agent = await this.resumeAgent(sessionId)
      const title = agent ? this.#sessionTitle(agent) : ''
      if (title) this.titleCache.set(sessionId, title)
      // 恢复不出来的会话也照样报上去
      out.set(sessionId, title)
    }
    return out
  }
  /** 从 agent 上取会话名；取不到返回空串。 */
  #sessionTitle(agent) {
    const title = agent && agent.session && agent.session.title
    return title && String(title).trim() ? String(title).trim() : ''
  }

  /** 会话 id 候选：活 agent + 会话服务 + 工作区记着的。 */
  #candidateSessionIds() {
    const ids = new Set()

    const add = (raw) => {
      const id = String(raw == null ? '' : raw).trim()
      if (id) ids.add(id)
    }

    // ① 有活 agent 的
    const agents = this.#service('agents')
    if (agents && typeof agents.list === 'function') {
      try {
        for (const agent of agents.list() || []) {
          add((agent && agent.session && agent.session.id) || (agent && agent.sessionId))
        }
      } catch {
        // 退到下一种来源
      }
    }

    // ② 会话服务的全部清单
    const sessions = this.#service('sessions')
    if (sessions && typeof sessions.list === 'function') {
      try {
        for (const s of sessions.list() || []) {
          add((s && s.id) || (s && s.sessionId))
        }
      } catch {
        // 退到下一种来源
      }
    }

    return [...ids]
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
