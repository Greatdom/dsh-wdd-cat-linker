/**
 * 提示词拼装 —— 把一条来自 cat 服务器的消息变成 DSH 里的一轮提问。
 *
 * 为什么单独成文件：这是「消息注入 → 交给大模型」的唯一出入口。
 * 下一阶段的提示词工程（人格注入、记忆拼装、情境渲染）全部长在这里，
 * 让它和 HTTP 拉取、会话恢复这些搬运逻辑分开，改提示词时不用碰 inbound.js。
 */

import { plainText } from '../common/media.js'

/**
 * 一个会话的展示名。
 *
 * 群聊用群号（拿不到群名时），私聊用发送者名兜底 —— 拼进正文让人一眼看出「在哪、谁说的」。
 */
export function chatLabel(message) {
  const type = message.chatType === 'group' ? '群聊' : '私聊'
  const who = message.senderName || message.senderId || '未知'
  return `${type} ${message.chatId}，发送者 ${who}`
}

/**
 * 把一条入站消息拼成 DSH 里的一轮用户提问。
 *
 * 正文形状（刻意固定）：
 *
 *   【来自外部聊天】群聊 20001，发送者 用户10002：
 *   今天好累啊
 *
 *   （回复必须调用 submit_replies 工具，否则对方收不到。）
 *
 * 两条硬编码的固定文案不要抽成常量：
 *
 *   · 前缀是「这轮是外部消息」的标记，跳过它模型就不知道自己该往哪回；
 *   · 后缀是强制交卷的提醒，少了它模型会只在界面上打字、对方收不到。
 *
 * 它们只在拼提示词这一处出现，抽到常量文件反而让阅读时要跳文件。将来改写文案时
 * 也只改这个函数，不要让别的模块跟着变。
 *
 * @param {object} message cat 服务器返回的入站消息
 * @returns {string} 提示词正文；正文为空时返回空串
 */
export function buildInboundPrompt(message) {
  const text = plainText(message && message.content)
  if (!text) return ''

  return `【来自外部聊天】${chatLabel(message)}：\n`
    + `${text}\n\n`
    + '（回复必须调用 submit_replies 工具，否则对方收不到。）'
}
