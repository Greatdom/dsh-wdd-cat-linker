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
import { MessageCache } from './src/common/message_cache.js'
import { SessionFinder } from './src/common/session_finder.js'
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
})

export function apply(ctx, config) {
  const settings = { ...Config(), ...(config || {}) }

  // ── 基础设施 ──────────────────────────────────────────────
  const log = (text, meta) => {
    try {
      ctx.logger?.info?.(`[cat-linker] ${text}`, meta)
    } catch {
      // 宿主日志不可用时不影响链路
    }
  }

  const bridge = new Bridge({
    baseUrl: settings.catBaseUrl,
    timeoutMs: settings.requestTimeoutMs,
  })
  const finder = new SessionFinder(ctx)
  const cache = new MessageCache()

  // ── 三个业务件 ────────────────────────────────────────────
  const heartbeat = new Heartbeat({ bridge, finder, log })
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

  // ── 出站：监听一轮结束 ────────────────────────────────────
  // 必须用 ctx.effect 包着：裸 ctx.on 拿不到插件的生命周期，
  // 回调可能永远不触发，而且卸载时不会解绑。
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
