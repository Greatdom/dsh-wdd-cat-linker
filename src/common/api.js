export const API = {
  /**
   * 待投递队列。
   * <p>GET + 重复查询参数：Spring 的 @RequestParam List<String> 只认
   * `?sessionIds=a&sessionIds=b`，写成逗号串会被当成一个值。
   */
  get: (sessionIds) => {
    const query = (Array.isArray(sessionIds) ? sessionIds : [])
      .filter(Boolean)
      .map((id) => `sessionIds=${encodeURIComponent(id)}`)
      .join('&')
    return `/api/inbound_message/get${query ? '?' + query : ''}`
  },
  /** 确认投递成功。只有 ack 之后 Java 才推进水位。 */
  ack: '/api/inbound_message/ack',
  /** 一轮回复完成发往Java并返回ack */
  push: '/api/outbound_message/push',
  /** 心跳：声明要服务哪些存档、各自哪些聊天，顺带上报候选清单与日志。 */
  /**第一版只传会话 */
  heartbeat: '/api/heartbeat',
  /** 检测连接健康状态 */
  health: '/api/health'
}
