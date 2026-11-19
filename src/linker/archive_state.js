/** 专门拉取java的存档作为当前快照 */

import { API } from '../common/api.js'

/**
 * 存档快照。
 *
 * Java 是存档的唯一主人；跳板只读一份缓存，用来知道
 * 「哪个 archiveId 对应哪间会话、有哪几个渠道账号」。
 */
export class ArchiveState {
  /**
   * @param {object} deps
   * @param {import('../linker/bridge.js').Bridge} deps.bridge
   * @param {(text: string) => void} deps.log
   */
  constructor({ bridge, log }) {
    this.bridge = bridge
    this.log = log
    /** @type {Map<string, object>} archiveId → 存档视图 */
    this.byId = new Map()
    /** 上次拉失败就不再反复刷日志。 */
    this.failed = false
  }

  /** 从 Java 重新拉一遍。失败保留旧快照。 */
  async refresh() {
    let body
    try {
      body = await this.bridge.get(API.archives)
    } catch (error) {
      if (!this.failed) {
        this.log('拉存档失败（中转站没起来？）：' + String((error && error.message) || error))
        this.failed = true
      }
      return
    }
    this.failed = false

    const list = Array.isArray(body && body.data) ? body.data : []
    const next = new Map()
    for (const archive of list) {
      if (archive && archive.id) next.set(String(archive.id), archive)
    }
    this.byId = next
  }

  /** 全部存档视图。 */
  all() {
    return [...this.byId.values()]
  }

  /** 按 id 查。 */
  get(archiveId) {
    return this.byId.get(String(archiveId == null ? '' : archiveId))
  }

  /** 启用了的存档。 */
  enabled() {
    return this.all().filter((a) => a.enabled)
  }
}
