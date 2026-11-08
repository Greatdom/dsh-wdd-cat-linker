/**
 * 与 Java 中转站的接口路径。
 *
 * 全部集中在这里：路径一变，改一个地方，不用全局搜字符串。
 * 参数化的用函数，无参数的用常量。
 */
export const API = {
  /** 待投递队列。 */
  outbox: (limit) => `/api/v1/dsh/outbox?limit=${limit}`,
  /** 确认投递成功。只有 ack 之后 Java 才推进水位。 */
  ack: '/api/v1/dsh/ack',
  /** 一轮回复完成，发往 QQ。 */
  events: '/api/v1/dsh/events',
  /** 心跳：声明要轮询哪些聊天，顺带上报候选清单与日志。 */
  presence: '/api/v1/dsh/presence',
  /** 绑定表（以 Java 设置页为准）。 */
  bindings: '/api/v1/settings/bindings',
  /** 跳板配置（Java 托管，跳板定期拉）。 */
  linkerConfig: '/api/v1/linker/config',
}
