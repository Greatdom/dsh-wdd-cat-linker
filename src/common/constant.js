/**
 * 技术常量 —— 写死在代码里、用户改不了的那部分。
 *
 * 和 setting_store.js 的区别：
 *   · 这里：开发者改代码才变（会话 id 格式、日志短 id 长度、清理频率）；
 *   · 那边：用户在设置页能改（间隔、上限、开关），会落盘 linker.json。
 *
 * 判断标准：**用户改了会不会有可感知的好处？** 会 → 进 setting_store 的 SPEC；
 * 不会（改了只会让程序行为不可预期）→ 留在这里。
 */

/** DSH 会话 id 可能带的前缀。比较前一律去掉。 */
export const SESSION_PREFIX = 'session-'

/** 日志里显示的短 id 长度。 */
export const SHORT_ID_LEN = 8

/**
 * 清理失败出站消息的扫描间隔。
 *
 * 定成固定值：它决定的是「多久检查一次过期」，不是「留多久」。
 * 留多久是设置项 outboundFailTtlMs（可能变），扫描频率不该跟着变 ——
 * 否则用户把 ttl 调到 10 分钟，就会想让扫描也跟着变慢，反而更难调。
 */
export const OUTBOUND_SWEEP_INTERVAL_MS = 10000
