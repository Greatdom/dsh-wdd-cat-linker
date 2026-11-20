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

/**
 * 外部消息正文的前缀。
 *
 * 用它给「这一轮是不是外部消息触发」一个可靠判断：只有 inbound 会拼这个前缀，
 * 用户在界面上手打不可能带上。无状态上下文靠它决定抹不抹历史 ——
 * 抹错了会毁掉用户的正常对话。
 */
export const INBOUND_MARK = '【来自外部聊天】'

/** 外部消息正文末尾追加的固定提示。 */
export const INBOUND_SUFFIX = '（回复必须调用 submit_replies 工具，否则对方收不到。）'
