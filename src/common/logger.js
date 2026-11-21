/**
 * 跳板自己的日志缓冲。
 *
 * 两个数字在这里定死，不对外暴露：
 *   · CAPACITY —— 缓冲最多留多少条。这是**内存上限**，不是「上报多少」；
 *     上报多少由设置项 logUploadLimit 决定，运行时读取，所以这里只负责装得下。
 *
 * 为什么不做成设置项：缓冲容量属于性能参数，用户调它只会把内存撑大或把历史挤没，
 * 没有可感知的好处。真正的可调项是「上报几条给 cat 服务器」。
 */

/** 缓冲最多留多少条。 */
const CAPACITY = 200

export class LinkerLogger {
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

  /** 最近 N 条 */
  recent(limit = 50) {
    const capped = Math.max(1, Math.min(limit, CAPACITY))
    return this.entries.slice(Math.max(0, this.entries.length - capped))
  }

  /** 当前条数 */
  size() {
    return this.entries.length
  }
}
