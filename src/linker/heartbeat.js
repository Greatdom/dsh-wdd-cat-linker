/** 专门管理心跳 */

import { API } from '../common/api.js'

import { LOG_UPLOAD_LIMIT } from '../common/constant.js'


/**
 * 心跳：
 */
export class Heartbeat {
  /**
   * @param {object} deps
   * @param {import('../linker/bridge.js').Bridge} deps.bridge
   * @param {import('../common/session_finder.js').SessionFinder} deps.finder
   * @param {import('../common/logger.js').LinkerLogger} [deps.logger] 日志缓冲
   * @param {{ get: (key: string) => any }} [deps.store] 本地配置；每轮现读，设置页改完下一跳生效
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ bridge, finder, logger, store, log }) {
    this.bridge = bridge
    this.finder = finder
    this.logger = logger || null
    this.store = store || null
    this.log = log
    /** 正在跑的一轮（single-flight）。 */
    this.running = null
    this.stopped = false
    /** 最近一次算出的会话表，inbound 用它的键去取消息。 */
    this.sessions = new Map()
    /** 上次报上去的清单，没变就不重复刷日志。 */
    this.lastReported = null
    this.failed = false
  }

  /** 心跳入口。上一轮没跑完就复用上一轮心跳 */
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.#run()
      .catch((error) => {
        this.log('心跳出错：' + String((error && error.message) || error))
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  async #run() {
    this.sessions = await this.finder.getAllSessions()

    // 先取日志快照再发心跳
    const logs = this.logger ? this.logger.recent(this.#uploadLimit()) : []

    const body = {
      sessions: Object.fromEntries(this.sessions),
    }
    if (logs.length) {
      body.logs = logs
    }

    try {
      await this.bridge.post(API.heartbeat, body)
    } catch (error) {
      if (!this.failed) {
        this.log('心跳上报失败（中转站没起来？）：' + String((error && error.message) || error))
        this.failed = true
      }
      return
    }
    this.failed = false

    const key = [...this.sessions.keys()].join(',')
    if (key !== this.lastReported) {
      this.lastReported = key
      this.log(`心跳：报上 ${this.sessions.size} 个可用会话`)
    }
  }

  /**
   * 这一次上报几条日志。
   *
   * 每轮现读设置：设置页保存后，下一跳心跳就按新值上报，不用重启 DSH。
   * 拿不到或非法时退回 LOG_UPLOAD_LIMIT（与 Schema 默认值同源）。
   */
  #uploadLimit() {
    const fallback = LOG_UPLOAD_LIMIT
    if (!this.store || typeof this.store.get !== 'function') return fallback
    const value = Number(this.store.get('logUploadLimit'))
    if (!Number.isFinite(value)) return fallback
    // 与 setting_store.SPEC 的区间保持一致；越界就夹住，不信任调用方
    return Math.max(10, Math.min(200, Math.round(value)))
  }

  dispose() {
    this.stopped = true
  }
}
