/**
 * 日志：内存环形缓冲 + 宿主 logger，两个出口。
 *
 * 内存那份由心跳带给 Java，供 /logs 页面展示；宿主那份进 DSH 自己的日志文件。
 *
 * itemId 通过**显式参数**传递，不用模块级可变状态——
 * 之前用闭包里的 currentItemId，并发投递两条消息时会互相覆盖。
 */

import { FAILURE_LOG_INTERVAL_MS, LOG_LIMIT } from './constants.js'

const LEVELS = new Set(['info', 'warn', 'error'])

export class Logger {
  /**
   * @param {object} ctx cordis 上下文，用它的 logger
   */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Array<{time:number, level:string, itemId:string, text:string}>} */
    this.entries = []
    /** 同一条错误上次记录的时间，用于抑制重复。 */
    this.failures = new Map()
  }

  /**
   * @param {string} text
   * @param {{level?: 'info'|'warn'|'error', itemId?: string}} [meta]
   */
  write(text, meta = {}) {
    const level = LEVELS.has(meta.level) ? meta.level : 'info'
    const entry = { time: Date.now(), level, itemId: String(meta.itemId || ''), text }

    this.entries.push(entry)
    if (this.entries.length > LOG_LIMIT) this.entries.shift()

    this.#toHost(level, text)
  }

  /** 便捷入口，语义更清楚。 */
  info(text, meta) {
    this.write(text, meta)
  }

  warn(text, meta) {
    this.write(text, { ...meta, level: 'warn' })
  }

  /**
   * 同一条错误在窗口内只记一次。
   *
   * 按**文本分条**记录，不是只记「最后一条」——
   * 两种错误交替出现时，只记最后一条会让抑制完全失效。
   */
  failOnce(text, meta) {
    const now = Date.now()
    const last = this.failures.get(text)
    if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) return
    this.failures.set(text, now)
    this.warn(text, meta)
  }

  /** 最近 n 条，按心跳载荷的字段名裁剪。 */
  recent(limit) {
    return this.entries.slice(-limit).map((e) => ({
      time: e.time,
      level: e.level,
      itemId: e.itemId,
      text: e.text,
    }))
  }

  #toHost(level, text) {
    try {
      const logger = this.ctx?.logger
      const fn = level === 'error' ? logger?.error
        : level === 'warn' ? logger?.warn
          : logger?.info
      if (typeof fn === 'function') fn.call(logger, `wdd-cat-linker: ${text}`)
    } catch {
      // 宿主 logger 不可用不该影响主流程
    }
  }
}

/** 适配成 `(text, meta) => void`，给别的模块当依赖注入。 */
export function bindLogger(logger) {
  const fn = (text, meta) => logger.write(text, meta)
  fn.warn = (text, meta) => logger.warn(text, meta)
  fn.failOnce = (text, meta) => logger.failOnce(text, meta)
  return fn
}
