/**
 * 绑定源：本地插件配置（cordis.patch.yml）与 Java 设置页，二选一。
 *
 * 规则是 **Java 设置页优先**：页面配过就以页面为准，从没配过才用本地配置。
 * 判断依据是 Java 回的 `configured` 字段——
 * 它区分「用户清空了绑定」与「用户从没碰过绑定」，这两种绝不能混，
 * 否则删掉的绑定会自己长回来。
 */

import { API } from './api.js'
import { normalizeBindings } from './config.js'

export class BindingSource {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ getConfig, bridge, log }) {
    this.getConfig = getConfig
    this.bridge = bridge
    this.log = log
    /** '' | 'local' | 'java'，只用于避免重复打印同一份清单。 */
    this.source = ''
  }

  /** 从 Java 拉一次绑定，覆盖本地那份。拉不到就沿用现状。 */
  async refresh() {
    const settings = this.getConfig()

    let remote = null
    try {
      remote = await this.bridge.get(API.bindings)
    } catch (error) {
      this.log.failOnce('拉取绑定失败（沿用上一份）：' + String((error && error.message) || error))
      return
    }

    if (!remote || remote.configured !== true) {
      this.#switchTo('local', settings)
      return
    }

    const next = normalizeBindings(remote.bindings)
    const changed = JSON.stringify(next) !== JSON.stringify(settings.bindings)
    settings.bindings = next
    this.#switchTo('java', settings, changed)
  }

  /** 来源变了或绑定的内容变了才打日志。 */
  #switchTo(source, settings, force = false) {
    if (this.source === source && !force) return
    this.source = source

    const label = source === 'java' ? 'Java 设置页' : '本地插件配置'
    this.log(`绑定来源：${label}（${settings.bindings.length} 条）`)

    for (const binding of settings.bindings) {
      const key = `${binding.chatType}:${binding.chatId}`
      const target = binding.target === 'session'
        ? `会话 …${String(binding.sessionId || '').slice(-8)}`
        : `工作区 …${String(binding.workspaceId || '').slice(-8)}`
      this.log(`  ${key} → ${target}${binding.enabled === false ? '（已停用）' : ''}`)
    }
  }
}
