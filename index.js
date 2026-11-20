/**
 * DSH ↔ 服务器跳板 —— 插件入口。
 *
 * 本文件只做装配，不含业务判断：
 *   ① 心跳：告诉 Java「这些会话我能服务」，连同会话名；
 *   ② 入站：取 Java 队列 → 落池 → ack → followup 进 DSH 会话；
 *   ③ 出站：模型调 submit_replies 交卷 → turn/end 时推回 Java → 按 ack 清缓存。
 *
 * Java 中转站（cat）承担全部业务：OneBot 通信、消息段翻译、合并、
 * 攒批、限流、图片处理、身份与提示词渲染。
 */

import Schema from '@deepseek-ai/schemastery'

import { Heartbeat } from './src/linker/heartbeat.js'
import { Inbound } from './src/linker/inbound.js'
import { Outbound } from './src/linker/outbound.js'
import { Bridge } from './src/linker/bridge.js'
import { createSubmitRepliesTool } from './src/linker/submit_tool.js'
import { takeOverSession } from './src/linker/stateless_context.js'
import { blockScheduleTools } from './src/linker/schedule_guard.js'
import { MessageCache } from './src/common/message_cache.js'
import { SessionFinder } from './src/common/session_finder.js'
import { LocalStore, configFilePath, registerRoutes } from './src/common/setting_store.js'
import { LinkerLogger } from './src/common/logger.js'
import {
  HEARTBEAT_INTERVAL_MS,
  INBOUND_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from './src/common/constant.js'

/** 插件名（cordis 用它做去重/卸载标识）。 */
export const name = 'dsh-wdd-cat-linker'

/**
 * 依赖注入清单。少一个都会让插件不激活，所以只列真正用到的。
 * sessionController 不在这里：它通过 ctx.get() 惰性取，缺失只降级成「不恢复会话」。
 */
export const inject = ['agents', 'timer', 'tools']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关。关着 = 完全不收发'),
  catBaseUrl: Schema.string().default('http://127.0.0.1:8080').description('本地 Java 中转站地址'),
  heartbeatIntervalMs: Schema.number().default(HEARTBEAT_INTERVAL_MS)
    .description('心跳间隔（毫秒），与 legacy 一致'),
  inboundIntervalMs: Schema.number().default(INBOUND_INTERVAL_MS)
    .description('轮询待投递队列的间隔（毫秒）'),
  requestTimeoutMs: Schema.number().default(REQUEST_TIMEOUT_MS)
    .description('单次请求超时（毫秒）'),
  systemPrompt: Schema.string().default('')
    .description('无状态模式下的固定人设；留空则只抹历史、不改系统提示词'),
})

export function apply(ctx, config) {
  const settings = { ...Config(), ...(config || {}) }

  // 日志：既打到宿主控制台，也留一份给心跳上报 ——
  const logger = new LinkerLogger({
    sink: (text, entry) => {
      try {
        const line = `[cat-linker] ${text}`
        if (entry.level === 'ERROR') ctx.logger?.error?.(line)
        else if (entry.level === 'WARN') ctx.logger?.warn?.(line)
        else ctx.logger?.info?.(line)
      } catch {
        // 宿主日志不可用时不影响链路
      }
    },
  })
  const log = (text, meta) => logger.log(text, meta)

  const bridge = new Bridge({
    baseUrl: settings.catBaseUrl,
    timeoutMs: settings.requestTimeoutMs,
  })
  const finder = new SessionFinder(ctx)
  const cache = new MessageCache()

  // ── 本地配置 ──────────────────────────────────────────────
  const store = new LocalStore({
    file: configFilePath(ctx),
    settings,
    log,
  })
  store.hydrate()

  // 设置页读写路由。
  try {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const dispose = registerRoutes(webCtx, store)
        if (typeof dispose !== 'function') {
          log('设置页路由没挂上（webServer.register 不可用）')
        }
      } catch (error) {
        log('设置页路由注册失败：' + String((error && error.message) || error))
      }
    })
  } catch (error) {
    log('拿不到 webServer 服务（设置页不可用）：' + String((error && error.message) || error))
  }

  // ── 三个业务件 ────────────────────────────────────────────
  const heartbeat = new Heartbeat({ bridge, finder, logger, log })
  const inbound = new Inbound({ bridge, finder, cache, log })
  const outbound = new Outbound({ bridge, cache, log })

  // ── 交卷工具 ──────────────────────────────────────────────
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register(createSubmitRepliesTool({
      onSubmit: (draft) => outbound.submit(draft),
      log,
    }))
  } else {
    log('宿主没提供 tools 服务 —— 模型无法交卷，出站不可用')
  }

  // ── 日程工具拦截 ──────────────────────────────────────────
  // 日程归 Java 的 ScheduleService 管，内置工具直连会另建一套数据。
  // 只拦 cat 服务器推来的那一轮，界面直接聊天不受影响。
  blockScheduleTools(ctx, cache, log)

  // ── 无状态上下文：严格照 dsh-wdd-context 的写法 ──────────────
  // 它实测能跑通，所以这里不用 ctx.effect 包、不用白名单，
  // 只把「哪些轮次算外部消息」的判断放进 pre-step。
  ctx.on('agent/created', ({ agent }) => {
    if (!settings.enabled) return
    if (!agent) {
      log('agent/created 没带 agent')
      return
    }
    if (!agent.ctx) {
      log('agent.ctx 不存在，无法接管')
      return
    }
    try {
      takeOverSession(agent.ctx, {
        systemPrompt: settings.systemPrompt,
        log,
      })
      log(`接管会话 …${String(agent.session?.id || '').slice(-8)} 的无状态上下文`)
    } catch (error) {
      log('接管无状态上下文失败：' + String((error && error.message) || error))
    }
  })

  // 已在运行的 agent 不会再触发 agent/created —— 补接管一次
  try {
    const agents = ctx.get?.('agents') ?? ctx.agents
    if (agents && typeof agents.list === 'function') {
      let resumed = 0
      for (const agent of agents.list() || []) {
        if (!agent || !agent.ctx) continue
        try {
          takeOverSession(agent.ctx, {
            systemPrompt: settings.systemPrompt,
            log,
          })
          resumed++
        } catch (error) {
          log('补接管失败：' + String((error && error.message) || error))
        }
      }
      if (resumed > 0) log(`补接管 ${resumed} 个已在运行的会话`)
    }
  } catch (error) {
    log('枚举已有 agent 失败：' + String((error && error.message) || error))
  }

  // ── 出站：监听一轮结束 ────────────────────────────────────
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (!settings.enabled) return
      try {
        outbound.handleSessionEvent(session, event)
      } catch (error) {
        // 单个事件出错绝不能把宿主的事件总线搞崩
        log('处理会话事件出错：' + String((error && error.message) || error))
      }
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // ignore
      }
    }
  }, 'dsh-wdd-cat-linker: 出站监听会话事件')

  // ── 定时器 ────────────────────────────────────────────────
  if (typeof ctx.interval !== 'function') {
    log('宿主没提供 timer（ctx.interval 不存在）—— QQ → DSH 收不到消息')
    return
  }
  // ctx.interval 内部已托管清理，不要再包 ctx.effect。
  ctx.interval(() => {
    if (!settings.enabled) return
    // 心跳顺手算出了完整会话表，inbound 直接拿来去取消息
    void heartbeat.tick().then(() => {
      inbound.setSessionIds([...heartbeat.sessions.keys()])
    })
  }, settings.heartbeatIntervalMs)

  ctx.interval(() => {
    if (!settings.enabled) return
    void inbound.tick()
  }, settings.inboundIntervalMs)

  // ── 卸载清理 ──────────────────────────────────────────────
  ctx.effect(() => () => {
    heartbeat.dispose()
    inbound.dispose()
    outbound.dispose()
  }, 'dsh-wdd-cat-linker: 卸载清理')

  // ── 启动：立刻报一次心跳 ──────────────────────────────────
  // apply() 不能是 async（cordis 不等它），所以放自执行块。
  void (async () => {
    if (!settings.enabled) {
      log('总开关是关的，不发心跳也不取消息')
      return
    }
    await heartbeat.tick()
    inbound.setSessionIds([...heartbeat.sessions.keys()])
  })()
}
