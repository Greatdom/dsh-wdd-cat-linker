/**
 * 从 Java 拉跳板配置，覆盖本地默认值。
 *
 * 为什么不走 DSH 的配置系统：
 *   DSH 的 `configForms` 只服务 include 条目，通过 profile.bundles 装的插件
 *   拿不到（实测 rawStatus: unavailable）。所以配置由 Java 托管，
 *   跳板定期拉取——这也顺带实现了「改完不用重启」。
 *
 * ⚠ 只有「能改的那些项」会被覆盖。
 *   catBaseUrl / catToken 不在其中：那是「Java 在哪」的地址，
 *   要连上 Java 才能读它，循环依赖。
 */

import { API } from './api.js'

/** Java 那边能改、这边能覆盖的键。与 Java LinkerController.EDITABLE 对应。 */
const REMOTE_KEYS = [
  'enabled',
  'workspacePick',
  'relayOutbound',
  'relayInbound',
  'presenceIntervalMs',
  'outboxPollMs',
  'requestTimeoutMs',
]

export class RemoteSettings {
  /**
   * @param {object} deps
   * @param {object} deps.settings 可变的配置对象（normalizeConfig 的产物）
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ settings, bridge, log }) {
    this.settings = settings
    this.bridge = bridge
    this.log = log
    /** 上次拉到的值，用于只在变化时打日志。 */
    this.lastSnapshot = ''
    /** 是否曾经成功拉取过。 */
    this.everLoaded = false
  }

  /**
   * 拉一次并覆盖。失败静默——Java 没起来不该让心跳报错刷屏。
   *
   * @returns {Promise<boolean>} 是否成功
   */
  async refresh() {
    let remote
    try {
      const reply = await this.bridge.get(API.linkerConfig)
      remote = reply && reply.values
    } catch {
      return false
    }
    if (!remote || typeof remote !== 'object') {
      return false
    }

    const changed = []
    for (const key of REMOTE_KEYS) {
      if (!(key in remote)) continue
      const next = remote[key]
      if (next === undefined || next === null) continue
      if (this.settings[key] === next) continue
      this.settings[key] = next
      changed.push(key)
    }

    if (!this.everLoaded) {
      this.everLoaded = true
      this.log(`配置已从 Java 载入（${REMOTE_KEYS.length} 项可远程改）`)
      this.lastSnapshot = JSON.stringify(this.pick())
      return true
    }

    if (changed.length) {
      this.lastSnapshot = JSON.stringify(this.pick())
      this.log(`配置已更新：${changed.join('、')}（来自 Java 设置页）`)
    }
    return true
  }

  /** 当前生效的远端项快照（排查用）。 */
  pick() {
    const out = {}
    for (const key of REMOTE_KEYS) out[key] = this.settings[key]
    return out
  }
}
