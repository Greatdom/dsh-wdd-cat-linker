/**
 * 投递 —— 「把一条来自 cat 服务器的消息变成 DSH 里的一轮提问」。
 *
 * 这是入站链路的最后一公里，也是提示词工程唯一该长的地方：
 *   拼提示词 → 恢复会话 → followup 交给模型 → 标记「这一轮等着被回复」。
 *
 * 为什么从 inbound.js 拆出来：下一阶段的提示词工程（人格注入、记忆拼装、
 * 情境渲染）全部会长在 buildPrompt 里。放在这里，改提示词的人不用翻
 * 拉取、ack、报错那些搬运逻辑。
 */

import { shortId } from '../common/session_finder.js'
import { plainText, summarize } from '../common/media.js'

// ── 提示词 ────────────────────────────────────────────────
//
// 两条固定文案刻意写死在模板里，不放 constant.js：
//   · 前缀是「这轮是外部消息」的标记，模型靠它知道自己该往哪回；
//   · 后缀是强制交卷的提醒，少了它模型只在界面上打字、对方收不到。
// 它们只在这里出现，改写文案时只需要动一个函数。

/**
 * 一个会话的展示名。
 *
 * 群聊用群号，私聊用发送者名兜底 —— 拼进正文让人一眼看出「在哪、谁说的」。
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
 * @param {object} message cat 服务器返回的入站消息
 * @returns {string} 提示词正文；正文为空时返回空串
 */
export function buildPrompt(message) {
  const text = plainText(message && message.content)
  if (!text) return ''

  return `【来自外部聊天】${chatLabel(message)}：\n`
    + `${text}\n\n`
    + '（回复必须调用 submit_replies 工具，否则对方收不到。）'
}

// ── 投递 ──────────────────────────────────────────────────

/**
 * 把一条消息投进它归属的 DSH 会话。
 *
 * 三种丢弃情况（都只记日志，不抛异常，不影响同批其他消息）：
 *   ① 没有 sessionId —— 不知道该投给谁；
 *   ② 正文为空 —— 投进去模型也没东西可看；
 *   ③ 会话恢复不出来 —— 会话被删/归档，或 agent 起不来。
 *
 * 只依赖它真正需要的三样（finder / cache / log），不接整个 Inbound 实例 ——
 * 这样这个文件不依赖 linker 目录，也能单独测。
 *
 * @param {object} deps
 * @param {import('../common/session_finder.js').SessionFinder} deps.finder
 * @param {import('../common/message_cache.js').MessageCache} deps.cache
 * @param {(text: string, meta?: object) => void} deps.log
 * @param {object} message cat 服务器返回的入站消息
 * @returns {Promise<boolean>} 真的投进会话了返回 true；被丢弃返回 false
 */
export async function deliver({ finder, cache, log }, message) {
  const sessionId = String((message && message.sessionId) || '')
  if (!sessionId) {
    log('消息没有 sessionId，丢弃')
    return false
  }

  // 先判正文：空正文不值得为它恢复一次会话（恢复可能要读磁盘）
  const prompt = buildPrompt(message)
  if (!prompt) {
    log('消息正文为空，跳过')
    return false
  }

  const agent = await finder.resumeAgent(sessionId)
  if (!agent || typeof agent.followup !== 'function') {
    log(`会话 …${shortId(sessionId)} 打不开，丢弃这条消息`)
    return false
  }

  await agent.followup({
    // id = 渠道消息号 + 存档号：同一条消息投给多个存档时不会撞。
    // 用渠道号的原始值，不写死渠道名前缀 —— 跳板不认识「QQ」，
    // 它只认识 cat 服务器给的消息号（渠道是 cat 那边的事）。
    id: `${message.channelMessageId}-${message.archiveId}`,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    // source.kind 是封闭枚举，只有 user/assistant 这些；
    // 用 'user' 让界面把它当人话渲染
    source: { kind: 'user' },
  })

  // 投进去了才标记：这一轮等着被回复
  cache.markPending(message)

  log(`收到 ${message.chatType}:${message.chatId} → 会话 …${shortId(sessionId)}：`
    + summarize(plainText(message.content)))
  return true
}
