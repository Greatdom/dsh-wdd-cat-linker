/**
 * 跳板侧全部数值阈值。
 *
 * 集中一处，是为了让「同一个含义的数字」只有一个定义——
 * 之前 9 这个上限在 outbound.js 里写了两遍，改一处漏一处就会静默丢图。
 */

/** 会话 id 的前缀。DSH 里两种写法并存，所有比较前都要过 sessionKey()。 */
export const SESSION_PREFIX = 'session-'

/** 会话 id 在日志/提示里显示的尾段长度。 */
export const SHORT_ID_LEN = 8

/** 一次从 Java 最多取多少条待投递消息。 */
export const OUTBOX_PAGE_SIZE = 20

/** 「附件 id → 原图路径」映射上限，超出按插入顺序淘汰最旧的。 */
export const ORIGINAL_MAP_LIMIT = 200

/** 已上报轮次的去重集合上限，超出按插入顺序淘汰最旧的。 */
export const SENT_TURNS_LIMIT = 500

/** 「会话 → 本轮来源聊天」映射上限，超出按插入顺序淘汰最旧的。 */
export const SESSION_ORIGIN_LIMIT = 100

/** 一轮里最多带几张图。DSH 消息里抽取与上报两处必须用同一个值。 */
export const MAX_IMAGES_PER_TURN = 9

/** 内存日志保留条数。 */
export const LOG_LIMIT = 80

/** 每次心跳上报给 Java 的日志条数。 */
export const LOG_UPLOAD_LIMIT = 50

/** 同一条错误在这个间隔内只记一次，避免 Java 没起来时每 5 秒刷一屏。 */
export const FAILURE_LOG_INTERVAL_MS = 60_000

/** 日志摘要的默认截断长度。 */
export const SUMMARY_LEN = 40

/** 投递日志里摘要的截断长度（比默认更短，一行能放下）。 */
export const DELIVERY_SUMMARY_LEN = 30
