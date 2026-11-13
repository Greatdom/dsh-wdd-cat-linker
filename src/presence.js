/**
 * 心跳：告诉 Java「这些存档现在归我服务、各自能服务哪些聊天」，
 * 顺带上报候选清单与日志。
 *
 * 一个请求带三样东西，是因为它们都是跳板本来就要算的，
 * 合并上报零额外开销；拆开就得为每一样各加一条链路。
 *
 * ---- 存档制度下的变化 ----
 *
 * 原来上报的是「一堆聊天」（一维，全局一个机器人）；
 * 现在上报的是「每个存档 + 它的会话状态 + 它能服务的聊天」（两维）。
 *
 * ⚠ `archives` 的三种取值语义完全不同，Java 侧据此分支：
 *   · `[]`   —— 明确关掉：总开关关了，或一个存档都没有；
 *   · `null` —— 这次别动清单：有存档但一个都解析不出活会话（临时状态）；
 *   · `[...]`—— 正常，整体替换。
 * 把 `null` 写成 `[]` 会让一次临时失败把整条链路停掉——这是踩过的坑。
 *
 * ---- 会话丢失（设计文档 Q3-B）----
 *
 * 会话打不开时如实上报 `sessionStatus: 'LOST'`，**不自动重建**。
 * Java 会把状态写回存档，存档管理页显示红字让人来重新选一个。
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
   * @param {import('./archives.js').ArchiveSource} deps.archives
   * @param {import('./logger.js').Logger} deps.logger
   */
  constructor({ getConfig, resolver, bridge, archives, logger }) {
    this.getConfig = getConfig
    this.resolver = resolver
    this.bridge = bridge
    this.archives = archives
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
    // 先拉存档，再算会话状态——顺序反了会用上一份旧清单
    await this.archives.refresh()

    const settings = this.getConfig()
    const served = await this.#servedArchives(settings)

    // 有存档却一个都解析不出活会话 = 临时状态，别让 Java 清空清单
    const hasArchives = this.archives.archives.length > 0
    const payload = served.length === 0 && settings.enabled && hasArchives
      ? null
      : served

    try {
      await this.bridge.post(API.presence, {
        archives: payload,
        candidates: this.#candidates(),
        logs: this.logger.recent(LOG_UPLOAD_LIMIT),
      })
    } catch (error) {
      this.logger.failOnce('上报 presence 失败（Java 中转站没起来？）：'
        + String((error && error.message) || error))
    }
  }

  /**
   * 当前每个存档能服务的状态。
   *
   * <p>**会尝试恢复会话**：DSH 的 agent 按需创建、用完回收，所以「会话没打开」是常态。
   * 如果这里只查内存，存档就会在心跳里「消失」，Java 的 `servedChats` 掉到 0，整条链路停摆。
   *
   * <p>为什么不会拖垮 DSH：
   *   · 恢复成功 → 记进 {@link opened}，之后直接命中，不再重复恢复；
   *   · 恢复失败 → 冷却 {@link RETRY_COOLDOWN_MS} 再试，不会每 5 秒读一次盘。
   *
   * @returns {Promise<Array<{archiveId, sessionId, sessionStatus, chats}>>}
   */
  async #servedArchives(settings) {
    if (!settings.enabled) return []

    const out = []
    for (const archive of this.archives.enabled()) {
      const sessionId = archive.sessionId
      const chats = archive.relations.map((r) => ({ chatType: r.chatType, chatId: r.chatId }))

      // 没绑会话 = 这个存档现在收不了消息，如实报 LOST
      if (!sessionId) {
        out.push({
          archiveId: archive.id,
          sessionId: '',
          sessionStatus: 'LOST',
          chats,
        })
        continue
      }

      const alive = await this.#ensureOpen(sessionId)
      out.push({
        archiveId: archive.id,
        sessionId,
        sessionStatus: alive ? 'BOUND' : 'LOST',
        chats,
      })
    }
    return out
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

  /** 会话 / 工作区候选清单，供存档管理页的下拉框使用。 */
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
