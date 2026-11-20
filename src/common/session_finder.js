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
 *
 * <p>枚举会话与取名字都走 {@code sessionQuery} —— 它能读磁盘上的全部会话，
 * 不要求会话打开着：
 * <ul>
 *   <li>{@code listSessions()} —— 全部会话；</li>
 *   <li>{@code readTitle(id)} —— 从会话日志里折叠出标题，没打开的也行。</li>
 * </ul>
 *
 * <p>{@code agents.list()} 只返回内存里挂着的 agent，只能当兜底 ——
 * 存档要绑的会话是「存在」就够，现在没打开不代表不能用。
 */
export class SessionFinder {
  /**
   * @param {object} ctx cordis 上下文
   * @param {(text: string) => void} [log] 日志口，排障时用
   */
  constructor(ctx, log) {
    this.ctx = ctx
    this.log = log || null
    /** 取到的服务缓存：插件生命周期内不变。 */
    this.services = new Map()
    /** 全局的 sessionId → 会话名缓存。 */
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
    // 只缓存拿到的：服务可能比插件晚就绪，把 undefined 缓存住就永远拿不到了
    if (value !== undefined && value !== null) {
      this.services.set(name, value)
    }
    return value
  }

  /**
   * 全部会话，含没加载到内存的。
   *
   * @returns {Promise<Map<string, string>>} sessionId → 会话名（拿不到名字时给空串）
   */
  async getAllSessions() {
    const out = new Map()

    for (const id of await this.allSessionIds()) {
      const cached = this.titleCache.get(id)
      if (cached) {
        out.set(id, cached)
        continue
      }
      const title = await this.sessionTitle(id, true)
      if (title) {
        this.titleCache.set(id, title)
      } else if (this.log) {
        this.log(`会话 ${shortId(id)} 取不到名字`)
      }
      // 拿不到名字也照样报上去 —— 会话本身是存在的
      out.set(id, title)
    }
    return out
  }

  /**
   * **全部**会话 id（不只是有活 agent 的）。
   *
   * @returns {Promise<string[]>}
   */
  async allSessionIds() {
    const byKey = new Map()

    const add = (rawId) => {
      const id = String(rawId == null ? '' : rawId).trim()
      if (!id) return
      const key = sessionKey(id)
      if (!key || byKey.has(key)) return
      byKey.set(key, id)
    }

    // ① sessionQuery.listSessions() —— 磁盘上所有会话，含没打开的
    const query = this.#service('sessionQuery')
    if (query && typeof query.listSessions === 'function') {
      try {
        const list = await query.listSessions()
        // 有的版本给数组，有的包一层 { sessions: [...] }
        const rows = Array.isArray(list)
          ? list
          : (list && Array.isArray(list.sessions) ? list.sessions : [])
        if (this.log) {
          this.log(`listSessions 返回 ${describe(list)}，解析出 ${rows.length} 条`)
        }
        for (const s of rows) {
          add((s && s.id) || (s && s.sessionId))
        }
      } catch (error) {
        if (this.log) this.log('listSessions 失败：' + String((error && error.message) || error))
      }
    } else if (this.log) {
      this.log('sessionQuery ' + (query ? '没有 listSessions 方法' : '服务不存在'))
    }

    // ② workspaceRegistry.list()[].sessionIds —— 工作区记着的会话
    //    没打开的会话主要靠这一条：agent 回收了，但工作区还记得它
    const registry = this.#service('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      try {
        const list = registry.list() || []
        let found = 0
        for (const ws of list) {
          const ids = ws && ws.sessionIds
          if (!Array.isArray(ids)) continue
          for (const id of ids) {
            found++
            add(id)
          }
        }
        if (this.log) this.log(`workspaceRegistry 有 ${list.length} 个工作区，共 ${found} 条会话记录`)
      } catch (error) {
        if (this.log) this.log('workspaceRegistry.list 失败：' + String((error && error.message) || error))
      }
    } else if (this.log) {
      this.log('workspaceRegistry ' + (registry ? '没有 list 方法' : '服务不存在'))
    }

    // ③ sessions.list() —— 会话服务自己的清单
    const sessions = this.#service('sessions')
    if (sessions && typeof sessions.list === 'function') {
      try {
        const rows = sessions.list() || []
        if (this.log) this.log(`sessions.list 返回 ${rows.length} 条`)
        for (const s of rows) {
          add((s && s.id) || (s && s.sessionId))
        }
      } catch (error) {
        if (this.log) this.log('sessions.list 失败：' + String((error && error.message) || error))
      }
    }

    // ④ 活 agent（兜底，保证不漏掉正在用的）
    const live = this.liveSessionIds()
    if (this.log) this.log(`agents.list 返回 ${live.length} 个活会话`)
    for (const id of live) add(id)

    if (this.log) this.log(`枚举完成：共 ${byKey.size} 个会话`)
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
   * 会话显示名。
   *
   * <p>取名的顺序（能拿到就用）：
   * <ol>
   *   <li>{@code sessionQuery.readTitle(id)} —— 从会话日志折叠标题，没打开的也行；</li>
   *   <li>{@code sessionTitle.get(session)} —— 标题服务要真的 session 对象；</li>
   *   <li>{@code sessions.get(id).title} —— 会话对象自带的；</li>
   *   <li>{@code agents.get(id).session.title} —— 活 agent 上带的。</li>
   * </ol>
   *
   * @param {string} sessionId
   * @param {boolean} [verbose] 排障用：把每个来源的实际结果都记下来
   * @returns {Promise<string>} 会话名；拿不到返回 ''
   */
  async sessionTitle(sessionId, verbose = false) {
    const raw = String(sessionId == null ? '' : sessionId).trim()
    if (!raw) return ''

    const trace = (where, value) => {
      if (verbose && this.log) {
        this.log(`取名 ${shortId(raw)} @ ${where} → ${describe(value)}`)
      }
    }

    // ① sessionQuery.readTitle(id) —— 最靠得住，不要求会话活着
    const query = this.#service('sessionQuery')
    if (query && typeof query.readTitle === 'function') {
      for (const id of idVariants(raw)) {
        try {
          const snapshot = await query.readTitle(id)
          trace(`sessionQuery.readTitle(${id})`, snapshot)
          const title = pickTitle(snapshot)
          if (title) return title
        } catch (error) {
          trace(`sessionQuery.readTitle(${id}) 抛错`, error)
        }
      }
    } else {
      trace('sessionQuery', query ? '没有 readTitle 方法' : '服务不存在')
    }

    // ② sessionTitle.get(session) —— 要真的 session 对象，不是 {id}
    const titles = this.#service('sessionTitle')
    const live = this.#liveSession(raw)
    if (titles && typeof titles.get === 'function' && live) {
      try {
        const snapshot = titles.get(live)
        trace('sessionTitle.get(session)', snapshot)
        const title = pickTitle(snapshot)
        if (title) return title
      } catch (error) {
        trace('sessionTitle.get(session) 抛错', error)
      }
    } else if (!live) {
      trace('sessionTitle', '会话没活着，取不到 session 对象')
    }

    // ③ sessions.get(id).title
    try {
      const sessions = this.#service('sessions')
      if (sessions && typeof sessions.get === 'function') {
        for (const id of idVariants(raw)) {
          const s = sessions.get(id)
          trace(`sessions.get(${id})`, s)
          const title = pickTitle(s)
          if (title) return title
        }
      }
    } catch (error) {
      trace('sessions.get 抛错', error)
    }

    // ④ 活 agent 上带的
    const agent = this.findAgent(raw)
    trace('agents.get', agent ? agent.session : null)
    const fromAgent = pickTitle(agent && agent.session)
    if (fromAgent) return fromAgent

    return ''
  }

  /** 内存里的活 session 对象；没有返回 undefined。 */
  #liveSession(sessionId) {
    const sessions = this.#service('sessions')
    if (sessions && typeof sessions.get === 'function') {
      for (const id of idVariants(sessionId)) {
        try {
          const s = sessions.get(id)
          if (s) return s
        } catch {
          // 换下一种写法
        }
      }
    }
    const agent = this.findAgent(sessionId)
    return agent && agent.session
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

/**
 * 从各种可能的形状里挑出标题文本。
 * <p>可能是 {@code {title}}、{@code {title: {title}}}、裸字符串。
 */
function pickTitle(value) {
  if (value == null) return ''
  if (typeof value === 'string') {
    return value.trim()
  }
  if (typeof value !== 'object') return ''

  // 直接挂在对象上
  for (const key of ['title', 'name']) {
    const v = value[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // title 又包了一层（readTitleSnapshot 给的是 { title: { title: '...' } }）
  const nested = value.title
  if (nested && typeof nested === 'object') {
    for (const key of ['title', 'name']) {
      const v = nested[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return ''
}

/** 把一个值描述成一行短文本，排障日志用。 */
function describe(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 60 ? value.slice(0, 60) + '…' : value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return `Error(${value.message})`
  if (typeof value === 'object') {
    try {
      const keys = Object.keys(value)
      const head = keys.slice(0, 8).join(',')
      return `{${head}${keys.length > 8 ? ',…' : ''}}`
    } catch {
      return '[object]'
    }
  }
  return String(value)
}
