/**
 * 会话与 agent 解析：绑定 → 一间会话 + 它的 agent。
 *
 * 为什么这段必须在 JS：只有 DSH 知道哪间会话有活 agent、哪些已归档、
 * 工作区里哪间最近有活动。Java 只接收结论（presence），不需要知道这些。
 *
 * 工作区相关的查询委托给 {@link WorkspaceIndex}；本文件只管会话本身与 agent 生命周期。
 */

import { WorkspaceIndex } from './workspace.js'
import { idVariants, sameSession, sessionKey, shortId } from './session-id.js'

export class SessionResolver {
  /** @param {object} ctx cordis 上下文 */
  constructor(ctx) {
    this.ctx = ctx
    /** 取到的服务做缓存：它们在插件生命周期内不会变。 */
    this.services = new Map()

    this.workspace = new WorkspaceIndex({
      ctx,
      service: (name) => this.#service(name),
      findAgent: (id) => this.findAgent(id),
      liveSessionIds: () => this.liveSessionIds(),
    })
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

  // ─────────────────────────── agent ───────────────────────────

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
   * 只查内存里的 agent，两种 id 写法都试。**不触发恢复。**
   * @returns {object|undefined}
   */
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
   * 为什么需要它：`agents.get()` 查的是**内存里有没有常驻实例**，而 agent
   * 是按需创建、用完可能回收的。所以「UI 里还打得开这个会话」与
   * 「agents.get() 查得到」不是一回事——会话文件好好的，内存里却没有 agent。
   *
   * 走 `sessionController.agents.resolveAgent()` 而不是 `agents.resume()`：
   * 后者需要 agentOptions + setup 闭包，只有 session-controller 内部拿得到。
   *
   * @returns {Promise<object|undefined>}
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

  // ─────────────────────────── 查询入口 ───────────────────────────

  /** 归档 + 活会话快照，供工作区挑选复用。 */
  snapshotSessions() {
    return this.workspace.snapshot(this.liveSessionIds())
  }

  /** 全部工作区（字段已规整）。 */
  listWorkspaces() {
    return this.workspace.list()
  }

  /** 已归档的会话键集合。转发给 workspace，保持调用方只看 resolver 一个门面。 */
  archivedSessionKeys() {
    return this.workspace.archivedKeys()
  }

  /** 在工作区里挑一间会话，不恢复。 */
  pickSessionInWorkspace(workspaceId, pick = 'recent', snapshot) {
    return this.workspace.pickSession(workspaceId, pick, snapshot || this.snapshotSessions())
  }

  /** 会话显示名（日志用）。 */
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
    return key ? '…' + shortId(key) : '（未设置）'
  }

  // ─────────────────────────── 统一解析入口 ───────────────────────────

  /**
   * 把绑定解析成 `{ sessionId, agent, reason }` 或 `{ error }`。
   *
   * 这是**唯一**的解析入口。`resume` 决定「内存里没有 agent 时要不要从磁盘恢复」：
   *   · `false`（默认）—— 只查内存。心跳走这条，绝不触发恢复，
   *     否则每 5 秒一次心跳会把 DSH 拖慢；
   *   · `true`  —— 查不到就恢复。只有真正要投递消息时才用。
   *
   * @param {object} binding
   * @param {{pick?: 'recent'|'first', resume?: boolean, snapshot?: object}} [options]
   * @returns {Promise<{sessionId: string, agent: object|undefined, reason: string} | {error: string}>}
   */
  async resolveTarget(binding, options = {}) {
    if (!binding) return { error: '绑定为空' }
    const { pick = 'recent', resume = false, snapshot } = options

    if (binding.target === 'session') {
      const raw = String(binding.sessionId || '').trim()
      if (!raw) return { error: '绑定里没填 sessionId' }
      return this.#withAgent(raw, 'session', resume)
    }

    if (binding.target === 'workspace') {
      const picked = this.pickSessionInWorkspace(binding.workspaceId, pick, snapshot)
      if (!picked) {
        return { error: `工作区 …${this.workspace.shortId(binding.workspaceId)} 里没有活着的会话` }
      }
      return this.#withAgent(picked.sessionId, picked.reason, resume)
    }

    return { error: `未知的 target：${binding.target}` }
  }

  /** 取 agent（必要时恢复）并组装结果；拿不到就给 error。 */
  async #withAgent(sessionId, reason, resume) {
    const agent = resume ? await this.resumeAgent(sessionId) : this.findAgent(sessionId)
    if (!agent) {
      return {
        error: resume
          ? `会话 …${shortId(sessionId)} 打不开（可能已被归档或删掉）`
          : `会话 …${shortId(sessionId)} 现在没有活着的 agent`,
      }
    }
    return { sessionId, agent, reason }
  }

  // ─────────────────────────── 反查与路径 ───────────────────────────

  /**
   * 反查：这间会话说的话该发回哪些 QQ 聊天。
   * 同一间会话可以绑多个聊天（比如私聊 + 一个群）。
   */
  bindingsForSession(sessionIdToFind, bindings, pick = 'recent') {
    const snapshot = this.snapshotSessions()
    const result = []
    for (const binding of bindings) {
      if (binding.enabled === false) continue
      let mappedId = ''
      if (binding.target === 'session') {
        mappedId = binding.sessionId
      } else {
        const picked = this.workspace.pickSession(binding.workspaceId, pick, snapshot)
        mappedId = picked ? picked.sessionId : ''
      }
      if (mappedId && sameSession(mappedId, sessionIdToFind)) result.push(binding)
    }
    return result
  }

  /** 解析相对路径的根目录：会话所在工作区优先，再退到进程当前目录。 */
  rootsForSession(sessionId) {
    return this.workspace.rootsForSession(sessionId)
  }
}
