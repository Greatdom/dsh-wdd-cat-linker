export const API = {
  /** 待投递队列。 */
  get: `/api/inbound_message/get`,
  /** 确认投递成功。只有 ack 之后 Java 才推进水位。 */
  ack: '/api/inbound_message/ack',
  /** 一轮回复完成发往Java并返回ack */
  push: '/api/outbound_message/push',
  /** 心跳：声明要服务哪些存档、各自哪些聊天，顺带上报候选清单与日志。 */
  presence: '/api/heartheat',
  /** 存档列表（由 Java 托管，取代了原来的 bindings）。 */
  archives: '/api/archives',
  /** 生成日程并返回ack */
  date: '/api/date',
  /** 检测连接健康状态 */
  health:'/api/health'
}
