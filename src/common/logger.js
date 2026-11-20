/** 只实现跳板的日志管理而不实现宿主的日志管理 */

/**
 * 环形日志缓冲。
 *
 * 只收跳板自己的日志（宿主日志不归这里管）。保留最近 N 条，心跳时随会话清单
 * 一起报给 Java —— Java 的日志页才知道这一侧发生了什么。
 *
 * 一条记录的形状对齐 Java 的 LogBuffer.Entry：
 * { time, level, chatKey, itemId, logger, text }
 */

/** 保留条数：Java 侧存 150 条，这里多留些防止丢。 */
const CAPACITY = 200

export class LinkerLogger {
  /**
   * @param {object} [options]
   * @param {(text: string, meta?: object) => void} [options.sink] 真正的输出口
   */
  constructor({ sink } = {}) {
    /** 最近 N 条，按时间升序。 */
    this.entries = []
    this.sink = sink
  }

  /** 写一条。 */
  log(text, { level = 'INFO', logger = 'linker', itemId = null, chatKey = null } = {}) {
    const entry = {
      time: Date.now(),
      level,
      chatKey: chatKey == null ? null : String(chatKey),
      itemId: itemId == null ? null : String(itemId),
      logger: String(logger),
      text: String(text == null ? '' : text),
    }
    this.entries.push(entry)
    if (this.entries.length > CAPACITY) {
      this.entries.splice(0, this.entries.length - CAPACITY)
    }
    if (this.sink) {
      try {
        this.sink(entry.text, entry)
      } catch {
        // 输出口坏了不影响链路
      }
    }
    return entry
  }

  /** 便捷级别。 */
  warn(text, meta) {
    return this.log(text, { ...meta, level: 'WARN' })
  }

  error(text, meta) {
    return this.log(text, { ...meta, level: 'ERROR' })
  }

  /** 最近 N 条（按时间升序），心跳上报用。 */
  recent(limit = 50) {
    const capped = Math.max(1, Math.min(limit, CAPACITY))
    return this.entries.slice(Math.max(0, this.entries.length - capped))
  }

  /** 当前条数，排障用。 */
  size() {
    return this.entries.length
  }
}
