/** 常量管理 */

/** DSH 会话 id 可能带的前缀。比较前一律去掉。 */
export const SESSION_PREFIX = 'session-'

/** 日志里显示的短 id 长度。 */
export const SHORT_ID_LEN = 8

/** 一轮最多取几条消息。 */
export const INBOUND_PAGE_SIZE = 20

/** 心跳间隔 */
export const HEARTBEAT_INTERVAL_MS = 2000

/** 入站轮询间隔。 */
export const INBOUND_INTERVAL_MS = 2000

/** 单次请求超时 */
export const REQUEST_TIMEOUT_MS = 7000

/**
 * 日志上限的两个数各归各位：
 *
 *   · 缓冲容量 —— 在 logger.js 里定死，属于内存上限，不是可调项；
 *   · 上报条数 —— 设置项 logUploadLimit（10~200，默认见下），心跳每轮现读。
 *
 * 这里只留「默认值」：Schema 缺省和拿不到设置时的兜底都用它。
 */
export const LOG_UPLOAD_LIMIT = 50

/**
 * 推送失败的出站消息留多久再丢掉。
 *
 * 当前还没有重推逻辑，失败的消息只是「留一会儿再清」——留这段时间的意义是
 * 出问题时能在缓存里看到现场。设置项 outboundFailTtlMs 可调（5000~600000）。
 */
export const OUTBOUND_FAIL_TTL_MS = 60000

/** 清理失败出站消息的扫描间隔。固定值：改 ttl 不用重启，扫描频率跟它无关。 */
export const OUTBOUND_SWEEP_INTERVAL_MS = 10000
