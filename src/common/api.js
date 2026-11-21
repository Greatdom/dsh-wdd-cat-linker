export const API = {
  /**
   * 消息入站
   */
  get: (sessionIds) => {
    const query = (Array.isArray(sessionIds) ? sessionIds : [])
      .filter(Boolean)
      .map((id) => `sessionIds=${encodeURIComponent(id)}`)
      .join('&')
    return `/api/inbound_message/get${query ? '?' + query : ''}`
  },
  /** 确认入站成功 */
  ack: '/api/inbound_message/ack',
  /** 一轮回复完成发往Java并返回ack */
  push: '/api/outbound_message/push',
  /** 心跳：传会话,日志,渠道能力 */
  /**第一版只传会话和日志 */
  heartbeat: '/api/heartbeat',
  /** 检测连接健康状态 */
  health: '/api/health'
}
