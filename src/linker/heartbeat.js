/** 专门管理心跳 */

import { API } from '../common/api.js'

/**
 * 心跳：告诉 Java「我现在能为哪些会话服务」。
 *
 * 这是整条链的总闸 —— Java 侧 DedupProcessor 第 ⓪ 道校验对空清单是全拒。
 * 心跳不发，DSH 里永远收不到消息。
 *
 * 报上去的是 sessionId → 会话名，语义为整体覆盖。
 */
export class Heartbeat {
  /**
   * @param {object} deps
   * @param {import('../linker/bridge.js').Bridge} deps.bridge
   * @param {import('../common/session_finder.js').SessionFinder} deps.finder
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ bridge, finder, log }) {
    this.bridge = bridge
    this.finder = finder
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

  /** 心跳入口。上一轮没跑完就复用它的 Promise。 */
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

    try {
      // Map 直接进 JSON.stringify 会变成 {}，必须先转普通对象
      await this.bridge.post(API.heartbeat, { sessions: Object.fromEntries(this.sessions) })
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

  dispose() {
    this.stopped = true
  }
}
