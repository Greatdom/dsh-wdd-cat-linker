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
  }

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
    const chats = this.#servedChats(settings)

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
   * 只做**内存判断**，不恢复会话：心跳每几秒一次，
   * 在这里触发会话恢复会把 DSH 拖垮。
   */
  #servedChats(settings) {
    if (!settings.enabled) return []

    const snapshot = this.resolver.snapshotSessions()
    const chats = []
    for (const binding of settings.bindings) {
      if (binding.enabled === false) continue
      const picked = this.resolveInMemory(binding, settings.workspacePick, snapshot)
      if (picked) chats.push({ chatType: binding.chatType, chatId: binding.chatId })
    }
    return chats
  }

  /** 同步的「能不能落地」判断，等价于 resolveTarget({resume:false}) 但不走 async。 */
  resolveInMemory(binding, pick, snapshot) {
    if (binding.target === 'session') {
      return this.resolver.findAgent(binding.sessionId) ? binding.sessionId : null
    }
    if (binding.target === 'workspace') {
      const picked = this.resolver.pickSessionInWorkspace(binding.workspaceId, pick, snapshot)
      return picked ? picked.sessionId : null
    }
    return null
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
