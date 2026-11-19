/**
 * submit_replies 工具：模型交卷的唯一出口。
 *
 * 为什么用工具而不是让它自己吐 JSON：工具的 parameters 就是 schema，
 * 模型要交卷就必须按这个形状填，格式由宿主保证，不用手工容错解析。
 *
 * 一轮交一次卷，交完由 outbound 在 turn/end 时统一推给 Java。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** 工具名。 */
export const SUBMIT_REPLIES = 'submit_replies'

/**
 * 造一个 submit_replies 工具。
 *
 * @param {object} deps
 * @param {(draft: object) => void} deps.onSubmit 交卷回调
 * @param {(text: string) => void} deps.log
 */
export function createSubmitRepliesTool({ onSubmit, log }) {
  return defineTool({
    name: SUBMIT_REPLIES,
    description:
      '交出这一轮要发出去的话。想说几句就写几条，每条一句话；'
      + '不想说话就传空数组。这一步交完就结束本轮，不要再用普通文本回复。',
    parameters: {
      replies: {
        type: 'array',
        required: true,
        description: '要发出去的话，按顺序一条一句。不想说话就给空数组。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chatType: {
              type: 'string',
              description: '发给谁：private 或 group。不知道就留空，沿用收到的消息。',
            },
            chatId: {
              type: 'string',
              description: '会话号。不知道就留空，沿用收到的消息。',
            },
            text: {
              type: 'string',
              required: true,
              description: '这一条要说的内容。',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'integer' },
          sessionId: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已交卷 ${value.accepted} 条。`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = String((exec && exec.session && exec.session.id) || '')
      const replies = Array.isArray(args && args.replies) ? args.replies : []

      const accepted = replies.filter((r) => r && String(r.text || '').trim())
      onSubmit({
        sessionId,
        turn: Number(exec && exec.turn) || -1,
        replies: accepted.map((r) => ({
          chatType: r.chatType ? String(r.chatType).trim() : '',
          chatId: r.chatId ? String(r.chatId).trim() : '',
          text: String(r.text).trim(),
        })),
      })

      log(`交卷 ${accepted.length} 条（会话 …${sessionId.slice(-8)}）`)
      return { accepted: accepted.length, sessionId }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '交卷',
      kind: 'other',
      rawInput: args,
    }),
  })
}
