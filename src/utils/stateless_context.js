/**
 * 无状态提示词：每轮抹掉之前所有对话，只留本轮。
 *
 * 模型永远看不到上一轮说了什么，只看到：
 *   [system: 存档人设] [user: 本轮消息 + 固定后缀]
 * 好处是上下文成本恒定，不随对话变长而膨胀。
 *
 * 参考 references/dsh-wdd-context 的实现，有三个坑必须照抄：
 *   ① 不能碰 surface 节点 0（dsh 只允许用 system/message 原位改写它）
 *   ② 不能在 session/event 回调里直接 append（会撞上 "cannot reenter"）——
 *      推到 queueMicrotask 里做
 *   ③ 只有 step 1 才抹 —— 工具调用会把一轮拆成多个 step，
 *      每步都抹会把上一步的工具结果一起抹掉
 */

const textOf = (message) =>
  (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

const makeUserMessage = (text) => ({
  id: crypto.randomUUID(),
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

/**
 * 把 anchor 之前的全部历史折叠成一条 user 消息。
 *
 * 用会话自带的 surface replace：范围内的节点被一条新节点取代，
 * 之后模型再也看不到它们。日志本身仍是 append-only，历史可回放。
 *
 * @param anchor 本轮固定提示词在 surface 中的下标 —— 它之前的一切都属于历史
 */
function wipeHistory(session, anchor, log) {
  const nodes = [...session.surface.nodes]
  if (anchor <= 0 || anchor > nodes.length) return

  // 节点 0 里是最初那份 system prompt，它会被 systemPrompt.section 换成
  // 存档人设，留着不影响无状态；强行 replace 会被 dsh 拒绝。
  const from = 1
  if (anchor <= from) return

  const history = nodes.slice(from, anchor)
  if (history.length === 0) return

  session.append('user/message', makeUserMessage('[无状态] 更早的对话已丢弃。'), {
    surfaceOp: { op: 'replace', startSeq: history[0], endSeq: history[history.length - 1] },
    sourceEventSeqs: [...history],
  })
  log(`已抹掉 ${history.length} 个历史节点`)
}

/**
 * 接管一个会话：固定 system 段落 + 每轮抹历史。
 *
 * @param {object} agentCtx agent 自己的 cordis 上下文
 * @param {object} options
 * @param {string} options.systemPrompt 这个存档的人设
 * @param {import('../common/message_cache.js').MessageCache} options.cache 消息池，用来判定「本轮是不是外部消息触发的」
 * @param {(text: string) => void} options.log
 */
export function takeOverSession(agentCtx, { systemPrompt, cache, log }) {
  /** 已处理过的提示词 id，防止多步调用重复抹除。 */
  const wiped = new Set()
  /** 等落盘的提示词：id → anchor。pre-step 登记，session/event 认领。 */
  const pending = new Map()

  // 装载自检：这几个事件挂上了不代表会触发，所以要能看到它确实进来了
  log('无状态上下文已装载（agent/pre-step 等事件已注册）')

  // 提示词真正写进日志的那一刻才抹历史。
  // 不能在回调里直接 append：此时 entry.appending 仍为 true，会抛
  // "session append cannot reenter while another append is being published"。
  agentCtx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    const messageId = event.data?.id
    if (messageId === undefined) return

    const anchor = pending.get(messageId)
    if (anchor === undefined) return

    pending.delete(messageId)
    if (wiped.has(messageId)) return
    wiped.add(messageId)

    queueMicrotask(() => {
      try {
        wipeHistory(session, anchor, log)
      } catch (error) {
        log(`抹除失败（本轮照常进行）：${error}`)
      }
    })
  })

  // ① system：complete 段落，它会成为模型实际收到的唯一 prompt
  if (systemPrompt) {
    agentCtx.systemPrompt?.section?.({
      name: 'cat-linker:persona',
      order: 0,
      complete: true,
      interpolate: false,
      text: systemPrompt,
    })
  }

  // ② system 的日志一致性：complete 只改「发出去的」，日志里记的是原始渲染结果。
  //    在 waterfall 里把 sections 也换掉，落盘和实际请求才是同一份东西。
  if (systemPrompt) {
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      return {
        ...result,
        sections: [{ name: 'cat-linker:persona', text: systemPrompt, interpolate: false }],
        contexts: [],
      }
    })
  }

  // ③ user + 历史：接管这一步
  agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    const { agent, messages, turn, step } = payload
    // 进来就记一笔，能看出 pre-step 到底触没触发
    log(`pre-step 进来：turn ${turn} step ${step}，${messages.length} 条输入`)

    // 只有 step 1 才抹除。工具调用会让同一轮分出多个 step，
    // 每步都抹会把上一步刚写下的工具调用和结果一起抹掉。
    if (step > 1) return decision

    // 只处理 source.kind === 'user' 的：dsh 会把运行时上下文也写成 user 角色
    // （runtime-context / skill-catalog），只看 role 会把这些噪音当成本轮提问。
    const userTexts = messages
      .filter((m) => m.role === 'user' && m.source?.kind === 'user')
      .map((m) => textOf(m))
      .filter((text) => text.length > 0)

    // **只在外部消息触发时才接管**。
    //
    // 和 schedule_guard 用同一套判据：这个会话在 pending 池里还有没出站的外部消息，
    // 就说明这一轮是外部聊天触发的；界面上手打不会往 pending 池里放东西。
    // 不是外部触发就原样放行 —— 用户正常对话一个字都不能动。
    //
    // 副作用（已知，接受）：模型某轮没调用 submit_replies 交卷时，pending 会一直留着，
    // 那个会话里用户在界面上手打的对话也会被当成外部轮、历史被抹。
    const sessionId = String((agent && (agent.session?.id || agent.sessionId)) || '')
    if (!sessionId || !cache || typeof cache.peekPending !== 'function'
        || !cache.peekPending(sessionId)) {
      log(`pre-step：会话 …${sessionId.slice(-8) || '?'} 没有待应答的外部消息，放行`)
      return decision
    }

    // 严格无状态：只留用户输入（外部消息 + 界面上同轮的插话），
    // 运行时上下文那类噪音在上一步已经滤掉了。
    const prompt = makeUserMessage(userTexts.join('\n\n'))

    // 本轮提示词落盘时的 surface 长度 —— 它之前的一切才是「历史」。
    // agent 由 agent 级 ctx 的 waterfall 注入；万一没给就跳过抹除，
    // 但不影响本轮照常进行。
    const session = agent?.session
    if (!session || !session.surface) {
      log('pre-step 拿不到 agent.session，本轮不抹历史')
      return {
        kind: 'enter',
        messages: [prompt],
        startsRequestSeries: true,
      }
    }
    const anchor = session.surface.nodes.length
    pending.set(prompt.id, anchor)

    log(`turn ${turn} 无状态接管，${messages.length} 条输入只留 ${userTexts.length} 条用户消息`)
    return {
      kind: 'enter',
      messages: [prompt],
      startsRequestSeries: true,
    }
  })
}
