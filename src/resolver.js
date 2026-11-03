/**
 * 落点解析：把一条绑定变成「一间活着的会话」。
 *
 * 为什么这段必须留在 JS：只有 DSH 知道哪间会话现在有活着的 agent、
 * 哪些会话已归档、某个工作区里哪间最近有活动。Java 不该知道这些，
 * 所以它只接收「这些聊天我现在负责」的结论（presence）。
 *
 * 两种绑定：
 *   · target='session'   —— 直接给 sessionId，最可控，但换会话要改配置；
 *   · target='workspace' —— 只给 workspaceId，由这里自己挑一间（默认挑最近有活动的）。
 *
 * ⚠ 会话 id 有 `xxx` 和 `session-xxx` 两种写法，所有比较都必须先过 {@link sessionKey}，
 *   否则会静默失败（列表里有、就是匹配不上）。
 */

/** 会话 id 归一化：去掉 `session-` 前缀。 */
export function sessionKey(id) {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/** 判断两个会话 id 是不是同一间（无视前缀差异）。 */
export function sameSession(a, b) {
  return sessionKey(a) !== '' && sessionKey(a) === sessionKey(b)
}

export class SessionResolver {
  /** @param {object} ctx cordis 上下文 */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * 兼容多种取服务写法（不同 DSH 版本 `ctx.get` 与直接属性都出现过）。
   * @returns {any}
   */
  #service(name) {
    try {
      const viaGet = this.ctx.get?.(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch {
      // 落到下面直接取属性
    }
    return this.ctx[name]
  }

  /** 全部工作区。 */
  listWorkspaces() {
    const registry = this.#service('workspaceRegistry')
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

  /**
   * 已归档的会话键集合。
   * ⚠ 在 DSH 里 `archivedSessionIds` 是**方法**而不是属性；两种形态都兼容，方法优先。
   */
  archivedSessionKeys() {
    const out = new Set()
    const registry = this.#service('workspaceRegistry')
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

  /** 当前活着的会话 id。 */
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
   * 找一间会话「活着的 agent」。两种 id 写法都试。
   * @returns {object|undefined} 拿不到说明那间会话当前没开着
   */
  findAgent(sessionId) {
    const raw = String(sessionId == null ? '' : sessionId).trim()
    if (!raw) return undefined
    const agents = this.#service('agents')
    if (!agents || typeof agents.get !== 'function') return undefined

    const candidates = raw.startsWith('session-')
      ? [raw, raw.slice('session-'.length)]
      : [raw, 'session-' + raw]
    for (const id of candidates) {
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
   * 拿到「活着的 agent」，没有就从磁盘恢复。
   *
   * <p>为什么需要它：`agents.get(id)` 查的是**内存里有没有常驻的 agent 实例**，
   * 而 DSH 的 agent 是按需创建、用完可能回收的。所以「你还能在 UI 里和这个会话聊天」
   * 和「agents.get() 查得到」根本不是一回事——会话文件在磁盘上好好的，
   * 但内存里没有 agent，`get()` 就返回 undefined。
   *
   * <p>正确做法是走 `sessionController.agents.resolveAgent(id)`：
   * 它「解析或恢复，并发去重」，是 DSH 给普通会话准备的官方入口。
   * 直接调 `agents.resume()` 不行——那需要 `agentOptions` + `setup` 闭包，
   * 只有 session-controller 内部才拿得到。
   *
   * @returns {Promise<object|undefined>} agent 实例；恢不到返回 undefined
   */
  async resolveAgentAsync(sessionId) {
    const raw = String(sessionId == null ? '' : sessionId).trim()
    if (!raw) return undefined

    // 先查内存，省掉一次不必要的恢复
    const cached = this.findAgent(raw)
    if (cached) return cached

    const controller = this.#service('sessionController')
    const resolver = controller && controller.agents
    if (!resolver || typeof resolver.resolveAgent !== 'function') {
      // 宿主没提供（老版本 DSH，或这个插件跑在非宿主进程里）
      return undefined
    }

    try {
      const found = await resolver.resolveAgent(raw)
      if (found && !found.error && found.agent) return found.agent
    } catch {
      // 会话不存在、被归档、或恢复失败——都当作「拿不到」
    }
    return undefined
  }

  /** 会话显示名（日志/排查用）。 */
  sessionTitle(sessionId) {
    try {
      const service = this.#service('sessionTitle')
      if (service && typeof service.get === 'function') {
        const snapshot = service.get({ id: sessionId })
        if (snapshot && snapshot.title) return String(snapshot.title)
      }
    } catch {
      // ignore
    }
    const key = sessionKey(sessionId)
    return key ? '…' + key.slice(-8) : '（未设置）'
  }

  /**
   * 在工作区里挑一间会话。
   *
   * @param {string} workspaceId
   * @param {'recent'|'first'} pick
   * @returns {{sessionId: string, reason: string}|null}
   */
  pickSessionInWorkspace(workspaceId, pick = 'recent') {
    const registry = this.#service('workspaceRegistry')
    if (!registry || typeof registry.get !== 'function') return null

    let workspace
    try {
      workspace = registry.get(workspaceId)
    } catch {
      return null
    }
    if (!workspace) return null

    const archived = this.archivedSessionKeys()
    const live = new Set(this.liveSessionIds().map(sessionKey))
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : []

    // 候选：工作区名下、没归档、且当下确实有 agent
    let candidates = sessionIds
      .filter((id) => !archived.has(sessionKey(id)))
      .filter((id) => live.has(sessionKey(id)))

    if (!candidates.length) {
      // 退一步：有些工作区的 sessionIds 可能还没同步，只要有活 agent 就收
      candidates = sessionIds.filter((id) => this.findAgent(id))
    }
    if (!candidates.length) return null

    if (pick === 'first') {
      return { sessionId: candidates[0], reason: 'workspace:first' }
    }

    // recent：能拿到活动时间就用；拿不到按顺序取最后（越靠后一般越新）
    const sessions = this.#service('sessions')
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
    return { sessionId: scored[0].id, reason: 'workspace:recent' }
  }

  /**
   * 把一条绑定解析成「哪一间会话」。入站投递和出站反查都用它。
   *
   * @returns {{sessionId: string, reason: string} | {error: string}}
   */
  async resolveBinding(binding, pick = 'recent') {
    if (!binding) return { error: '绑定为空' }

    if (binding.target === 'session') {
      if (!this.findAgent(binding.sessionId)) {
        if(!this.resolveAgentAsync(sessionId))
        return { error: `会话 …${sessionKey(binding.sessionId).slice(-8)} 没开着（先去 DSH 里打开它）` }
      }
      return { sessionId: binding.sessionId, reason: 'session' }
    }
    if (binding.target === 'workspace') {
      const picked = this.pickSessionInWorkspace(binding.workspaceId, pick)
      if (!picked) {
        return { error: `工作区 …${String(binding.workspaceId).slice(-8)} 里没有活着的会话` }
      }
      return picked
    }
    return { error: `未知的 target：${binding.target}` }
  }

  /**
   * 反查：这间会话说的话，该发回哪些 QQ 聊天？
   * （同一间会话可以绑多个聊天，比如私聊 + 一个群。）
   */
  bindingsForSession(sessionIdToFind, bindings, pick = 'recent') {
    const result = []
    for (const binding of bindings) {
      if (binding.enabled === false) continue
      let mappedId = ''
      if (binding.target === 'session') {
        mappedId = binding.sessionId
      } else {
        const picked = this.pickSessionInWorkspace(binding.workspaceId, pick)
        mappedId = picked ? picked.sessionId : ''
      }
      if (!mappedId) continue
      if (sameSession(mappedId, sessionIdToFind)) result.push(binding)
    }
    return result
  }

  /**
   * 解析相对路径的根目录：先看会话所在工作区，再退到进程当前目录。
   * （模型回复里的 markdown 图片大多是相对工作区的路径。）
   */
  rootsForSession(sessionId) {
    const roots = []
    try {
      const key = sessionKey(sessionId)
      for (const ws of this.listWorkspaces()) {
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
}
