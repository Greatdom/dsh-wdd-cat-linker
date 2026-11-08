/**
 * 心跳：告诉 Java「这些聊天归我负责」，顺带上报候选清单与日志。
 *
 * 一个请求带三样东西，是因为它们都是跳板本来就要算的，
 * 合并上报零额外开销；拆开就得为每一样各加一条链路。
 *
 * ⚠ `chats` 的三种取值语义完全不同，Java 侧据此分支：
 *   · `[]`   —— 明确关掉：总开关关了，或绑定被删光了；
 *   · `null` —— 这次别动清单：有绑定但一条都解析不出活会话（临时状态）；
 *   · `[...]`—— 正常，整体替换。
 * 把 `null` 写成 `[]` 会让一次临时失败把整条链路停掉。
 */

import { API } from './api.js'
import { LOG_UPLOAD_LIMIT } from './constants.js'
import { sessionKey } from './session-id.js'

export class Presence {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {import('./resolver.js').SessionResolver} deps.resolver
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {import('./bindings.js').BindingSource} deps.bindings
   * @param {import('./logger.js').Logger} deps.logger
   */
  constructor({ getConfig, resolver, bridge, bindings, logger }) {
    this.getConfig = getConfig
    this.resolver = resolver
    this.bridge = bridge
    this.bindings = bindings
    this.logger = logger
    /** single-flight：上一轮没发完就跳过，避免堆请求。 */
    this.running = null

    /**
     * 已确认能打开的会话键。恢复成功后记下来，之后不再重复尝试。
     *
     * 为什么要缓存：`resumeAgent()` 要读磁盘、建上下文，是重操作。
     * 心跳每 5 秒一次，不缓存就等于每 5 秒给每间会话做一次恢复，会把 DSH 拖垮。
     */
    this.opened = new Set()

    /**
     * 恢复失败过一次的会话键 → 下次允许重试的时间戳。
     *
     * 会话可能稍后才被创建（比如用户手动打开），所以不能永久拉黑；
     * 但也不能每 5 秒重试一次 —— 失败通常是「会话不存在」，重试没有意义还浪费磁盘。
     */
    this.retryAfter = new Map()
  }

  /** 恢复失败的冷却时间：期间不再尝试，避免心跳里反复读盘。 */
  static RETRY_COOLDOWN_MS = 60_000

  /** 心跳入口。 */
  tick() {
    if (this.running) return this.running
    this.running = this.#run().finally(() => {
      this.running = null
    })
    return this.running
  }

  async #run() {
    // 先拉绑定，再算要拉哪些聊天——顺序反了会用上一份旧绑定
    await this.bindings.refresh()

    const settings = this.getConfig()
    const chats = await this.#servedChats(settings)

    // 有绑定却一条都解析不出来 = 临时状态，别让 Java 清空清单
    const payloadChats = chats.length === 0 && settings.enabled && settings.bindings.length > 0
      ? null
      : chats

    try {
      await this.bridge.post(API.presence, {
        chats: payloadChats,
        candidates: this.#candidates(),
        logs: this.logger.recent(LOG_UPLOAD_LIMIT),
      })
    } catch (error) {
      this.logger.failOnce('上报 presence 失败（Java 中转站没起来？）：'
        + String((error && error.message) || error))
    }
  }

  /**
   * 当前能真正落地的聊天。
   *
   * **会恢复会话**：DSH 的 agent 按需创建、用完回收，所以「会话没打开」是常态。
   * 如果这里只查内存，绑定就会在心跳里消失，Java 的 `servedChats` 掉到 0，整条链路停摆。
   *
   * 为什么不会拖垮 DSH：
   *   · 恢复成功 → 记进 {@link opened}，之后直接命中，不再重复恢复；
   *   · 恢复失败 → 冷却 {@link RETRY_COOLDOWN_MS} 再试，不会每 5 秒读一次盘。
   */
  async #servedChats(settings) {
    if (!settings.enabled) return []

    const snapshot = this.resolver.snapshotSessions()
    const chats = []
    for (const binding of settings.bindings) {
      if (binding.enabled === false) continue
      const picked = await this.resolveBinding(binding, settings.workspacePick, snapshot)
      if (picked) {
        const chat = { chatType: binding.chatType, chatId: binding.chatId }
        // 同一间会话可能被多条绑定共用，Java 那边按 chatKey 去重即可
        chats.push(chat)
      }
    }
    return chats
  }

  /**
   * 「这条绑定能不能用」判断 —— **会恢复会话**。
   *
   * 为什么必须恢复：DSH 的 agent 按需创建、用完回收。
   * 只查内存的话，会话一被切走，绑定就在心跳里「消失」，
   * Java 的 `servedChats` 掉到 0，整条链路停摆。
   *
   * 三档处理，避免把 DSH 拖垮：
   *   ① 在 {@link opened} 里 → 直接放行，零开销；
   *   ② 不在冷却期 → `resumeAgent()` 尝试恢复（成功就记进缓存）；
   *   ③ 恢复失败且还在冷却期 → 跳过，别每 5 秒读一次盘。
   *
   * @returns {Promise<string|null>} 能服务的会话 id
   */
  async resolveBinding(binding, pick, snapshot) {
    if (binding.target === 'session') {
      const id = String(binding.sessionId || '').trim()
      if (!id) return null
      return (await this.#ensureOpen(id)) ? id : null
    }

    if (binding.target === 'workspace') {
      // 工作区必须挑出一间具体会话，否则 Java 不知道该拉哪个聊天
      const picked = this.resolver.pickSessionInWorkspace(binding.workspaceId, pick, snapshot)
      if (!picked) return null
      return (await this.#ensureOpen(picked.sessionId)) ? picked.sessionId : null
    }

    return null
  }

  /**
   * 确保会话有活的 agent，有就返回 true。
   *
   * 命中缓存 / 冷却期内直接返回，不触发任何 IO。
   */
  async #ensureOpen(sessionId) {
    const key = sessionKey(sessionId)

    // ① 已经确认过能开
    if (this.opened.has(key)) return true

    // ② 内存里本来就有（不需要恢复，顺手记进缓存）
    if (this.resolver.findAgent(sessionId)) {
      this.opened.add(key)
      return true
    }

    // ③ 失败冷却期内，先别试
    const retryAt = this.retryAfter.get(key)
    if (retryAt !== undefined && Date.now() < retryAt) return false

    // ④ 真正去恢复
    const agent = await this.resolver.resumeAgent(sessionId)
    if (agent) {
      this.opened.add(key)
      this.retryAfter.delete(key)
      this.logger.write(`会话 …${key.slice(-8)} 已恢复，开始为它服务`)
      return true
    }

    // ⑤ 恢复失败：冷却后再试，期间不重试
    this.retryAfter.set(key, Date.now() + Presence.RETRY_COOLDOWN_MS)
    this.logger.failOnce(
      `会话 …${key.slice(-8)} 打不开（可能已归档或删除），`
      + `${Math.round(Presence.RETRY_COOLDOWN_MS / 1000)} 秒后重试`,
    )
    return false
  }

  /** 会话 / 工作区候选清单，供设置页的下拉框使用。 */
  #candidates() {
    const live = new Set(this.resolver.liveSessionIds().map(sessionKey))
    const archived = this.resolver.archivedSessionKeys()

    const sessions = []
    const seen = new Set()
    for (const id of this.resolver.liveSessionIds()) {
      const key = sessionKey(id)
      if (!key || seen.has(key)) continue
      seen.add(key)
      sessions.push({
        id,
        title: this.resolver.sessionTitle(id),
        alive: live.has(key) && !archived.has(key),
      })
    }

    const workspaces = this.resolver.listWorkspaces().map((ws) => ({
      id: ws.id,
      title: ws.title,
      path: ws.path,
    }))

    return { sessions, workspaces }
  }
}
