/** 常量管理 */

/** DSH 会话 id 可能带的前缀。比较前一律去掉。 */
export const SESSION_PREFIX = 'session-'

/** 日志里显示的短 id 长度。 */
export const SHORT_ID_LEN = 8

/** 一轮最多取几条消息。 */
export const INBOUND_PAGE_SIZE = 20

/** 心跳间隔（毫秒）。与 legacy 一致。 */
export const HEARTBEAT_INTERVAL_MS = 5000

/** 入站轮询间隔（毫秒）。 */
export const INBOUND_INTERVAL_MS = 2000

/** 单次请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 5000
