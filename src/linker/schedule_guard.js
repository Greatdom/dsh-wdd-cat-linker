/**
 * 拦截 DSH 内置的日程工具。
 *
 * 为什么拦：日程是「我这个存档」的记忆，应该由 Java 主导存进存档里。
 * 让内置工具直连会建成 DSH 侧的日程，跟 Java 的 ScheduleService 是两套数据，
 * 之后必然对不上。
 *
 * 拦截点：`tools/execute` waterfall。参考 @deepseek-ai/dsh-tool-call-timeout-policy，
 * 它就是这个钩子上「先 next()、再按情况替换结果」的官方范本。
 *
 * 第一版只拦截不转发 —— 模型想建日程时直接拿到一句「暂不支持」，
 * 等 Java 的 ADD_DATE 渠道通路做好，再改成就地转成一条 NormalMessage。
 */

/** DSH 内置日程工具，来自 @deepseek-ai/dsh-tool-schedule。 */
const BLOCKED_TOOLS = new Set([
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
])

/** 被拦时返回给模型的话。 */
const REFUSAL =
  '日程功能在这个存档里不可用：日程由外部中转站统一管理。'
  + '如果对方让你记某件事或设提醒，直接用文字说明你记下了，不要试图调日程工具。'

/** 拒绝结果，形状对齐 ToolExecutionResult。 */
function refusedResult(toolName) {
  return {
    content: [{ type: 'text', text: `Error: ${REFUSAL}（${toolName} 已拦截）` }],
    isError: true,
    error: {
      message: REFUSAL,
      info: { name: 'ScheduleToolBlocked', code: 'SCHEDULE_TOOL_BLOCKED' },
    },
  }
}

/**
 * 注册拦截。
 *
 * 只拦「由 cat 服务器流进来的消息所触发的那一轮」，用户在界面上直接
 * 聊天的轮次完全不受影响 —— 判断依据是 messageCache 里的 pending：
 * pending 只由 inbound 在投递成功后写入，界面手打不会产生它。
 *
 * @param {object} ctx cordis 上下文（插件级，不是 agent 级）
 * @param {import('../common/message_cache.js').MessageCache} cache
 * @param {(text: string) => void} log
 */
export function blockScheduleTools(ctx, cache, log) {
  ctx.effect(() => {
    const dispose = ctx.on('tools/execute', async (exec, next) => {
      const name = String((exec && exec.name) || '')
      if (!BLOCKED_TOOLS.has(name)) return next()

      // exec.agent.session.id 是官方用法，见 dsh-tools 内部 calls.run(exec.agent.session.id, ...)
      const sessionId = String(exec?.agent?.session?.id || '')
      // 没有 pending = 这一轮不是 cat 推来的，放行
      if (!sessionId || !cache.peekPending(sessionId)) return next()

      // 不调 next()：工具压根不执行，避免写进 DSH 侧的日程表
      log(`拦截内置日程工具 ${name}（会话 …${sessionId.slice(-8)}，来自 cat）`)
      return refusedResult(name)
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // ignore
      }
    }
  }, 'dsh-wdd-cat-linker: 拦截日程工具')
}
