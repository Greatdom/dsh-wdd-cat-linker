/**
 * DSH 会话事件名与取值。
 *
 * 这些是宿主定的封闭字符串，写错不会报错、只会静默不触发，
 * 所以宁可集中定义也不要散落在判断里。
 */

export const SESSION_EVENT = {
  /** 模型说了一段。这里只攒不发。 */
  assistantMessage: 'assistant/message',
  /** 一轮结束。只有 reason.kind 为 completed 才算说完。 */
  turnEnd: 'turn/end',
}

export const TURN_REASON = {
  completed: 'completed',
}
