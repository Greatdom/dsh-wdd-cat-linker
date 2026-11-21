/**
 * 拦截 DSH 内置的日程工具
 * 第一版只拦截不转发 
 */

/** DSH 内置日程工具,来自 @deepseek-ai/dsh-tool-schedule */
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
 * 拦截器
 */
export function blockScheduleTools(ctx, cache, log) {
  ctx.effect(() => {
    const dispose = ctx.on('tools/execute', async (exec, next) => {
      const name = String((exec && exec.name) || '')
      if (!BLOCKED_TOOLS.has(name)) return next()

      const sessionId = String(exec?.agent?.session?.id || '')
      // 不是外部传来的消息,放行
      if (!sessionId || !cache.peekPending(sessionId)) return next()

      // 拦截
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
