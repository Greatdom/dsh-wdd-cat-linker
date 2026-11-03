/**
 * DSH ↔ QQ 跳板 —— 插件入口。
 *
 * 本文件只做**装配**，不含业务判断：
 *   ① 出站监听：模型说完一轮 → 攒好 → 上报 Java；
 *   ② 入站投递：取 Java 队列 → followup 进会话 → ack；
 *   ③ 落点解析：绑定 → 一间会话；
 *   ④ 心跳：告诉 Java「这些聊天归我负责」。
 *
 * Java 中转站（cat）承担全部业务：OneBot 通信、消息段翻译、合并转发、
 * 攒批、限流、拆段节奏、图片处理、身份与提示词渲染。
 * 想改「它怎么说话、多久回几条」，去改 Java 的 application.yml，不用动这里。
 *
 * 模块分工见各文件的头注释。
 */

import { readFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

import { BindingSource } from './src/bindings.js'
import { Bridge } from './src/bridge.js'
import { normalizeConfig } from './src/config.js'
import { Inbound } from './src/inbound.js'
import { bindLogger, Logger } from './src/logger.js'
import { Outbound } from './src/outbound.js'
import { Presence } from './src/presence.js'
import { SessionResolver } from './src/resolver.js'
import { sessionKey } from './src/session-id.js'

/** 插件名（cordis 用它做去重/卸载标识）。 */
export const name = 'dsh-wdd-cat-linker'

/**
 * 依赖注入清单。少一个都会让插件不激活，所以只列真正用到的。
 *
 * ⚠ 不要加没验证过的服务名——多写一个会让整个插件静默不加载。
 *   sessionController 不在这里：它是通过 ctx.get() 惰性取的，
 *   缺失时只降级成「不恢复会话」，不影响插件激活。
 */
export const inject = ['agents', 'sessions', 'sessionTitle', 'timer', 'workspaceRegistry', 'attachments']

/** 一条绑定 = 一个 QQ 聊天 → 一处 DSH 落点。 */
const BindingSchema = Schema.object({
  chatType: Schema.string().default('private').description('private = 私聊，group = 群聊'),
  chatId: Schema.string().default('').description('私聊填对方 QQ 号，群聊填群号'),
  target: Schema.string().default('workspace').description('session = 指定会话，workspace = 工作区'),
  sessionId: Schema.string().default('').description('target=session 时填'),
  workspaceId: Schema.string().default('').description('target=workspace 时填'),
  label: Schema.string().default('').description('备注名，方便自己认'),
  enabled: Schema.boolean().default(true),
})

/** 用户可配置项：只有 DSH 侧的决策，节奏与策略在 Java。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关。关着 = 完全不收发'),
  catBaseUrl: Schema.string().default('http://127.0.0.1:8080').description('本地 Java 中转站地址'),
  catToken: Schema.string().default('').description('中转站开了鉴权才填'),
  bindings: Schema.array(BindingSchema).default([]).description('QQ 聊天 → DSH 落点'),
  workspacePick: Schema.string().default('recent').description('recent = 最近有活动的会话，first = 排最前的'),
  relayOutbound: Schema.boolean().default(true).description('DSH → QQ'),
  relayInbound: Schema.boolean().default(true).description('QQ → DSH'),
  presenceIntervalMs: Schema.number().default(5000).description('心跳间隔（告诉 Java 要拉哪些聊天）'),
  outboxPollMs: Schema.number().default(1500).description('轮询待投递队列的间隔'),
  requestTimeoutMs: Schema.number().default(5000).description('单次请求超时'),
})

export function apply(ctx, config) {
  const settings = normalizeConfig(config)

  // ── 基础设施 ──────────────────────────────────────────────
  const logger = new Logger(ctx)
  const log = bindLogger(logger)
  const resolver = new SessionResolver(ctx)
  const bridge = new Bridge({
    baseUrl: settings.catBaseUrl,
    token: settings.catToken,
    timeoutMs: settings.requestTimeoutMs,
  })

  const attachmentsService = () => {
    try {
      return ctx.get?.('attachments') || ctx.attachments
    } catch {
      return undefined
    }
  }

  // ── 四个业务模块 ────────────────────────────────────────────
  const bindings = new BindingSource({ getConfig: () => settings, bridge, log })

  const inbound = new Inbound({
    getConfig: () => settings,
    resolver,
    bridge,
    log,
    attachmentsService,
  })

  const outbound = new Outbound({
    getConfig: () => settings,
    resolver,
    bridge,
    log,
    attachmentsService,
    resolveOriginal: (attachmentId) => inbound.resolveOriginal(attachmentId),
  })

  const presence = new Presence({
    getConfig: () => settings,
    resolver,
    bridge,
    bindings,
    logger,
  })

  // ── 出站：监听会话事件 ──────────────────────────────────────
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        outbound.handleSessionEvent(session, event)
      } catch (error) {
        // 单个事件处理出错绝不能把宿主的事件总线搞崩
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
  }, 'wdd-cat-linker: 出站监听会话事件')

  // ── 定时器 ─────────────────────────────────────────────────
  // ⚠ ctx.interval 内部已用 ctx.effect 托管清理，不要再包一层 ctx.effect。
  if (typeof ctx.interval !== 'function') {
    log('宿主没提供 timer（ctx.interval 不存在）—— QQ → DSH 收不到消息，DSH → QQ 也不可用')
  } else {
    ctx.interval(() => { void presence.tick() }, settings.presenceIntervalMs)
    ctx.interval(() => { void inbound.tick() }, settings.outboxPollMs)
  }

  // 卸载时停掉投递并清缓存
  ctx.effect(() => () => {
    inbound.dispose()
    outbound.dispose()
  }, 'wdd-cat-linker: 卸载清理')

  // ── 启动：拉一次绑定、打印清单、立刻报一次心跳 ───────────────
  // apply() 不能是 async（cordis 不等它），所以启动逻辑放在自执行块里。
  void (async () => {
    await bindings.refresh()

    log(`已装好 v${readVersion()}｜总开关 ${settings.enabled ? '开' : '关'}`
      + `｜绑定 ${settings.bindings.length} 条`
      + `｜中转站 ${settings.catBaseUrl}`)

    if (!settings.bindings.length) {
      log(settings.enabled
        ? '绑定是空的——链路会停。去 Java 设置页 http://127.0.0.1:8080/settings 加一条'
        : '还没有绑定：在插件配置里加一条，或去 Java 设置页加（QQ 聊天 → 会话或工作区）')
    }
    if (!settings.enabled) {
      log('总开关是关的。调通之前建议先关着，确认无误再打开。')
    }

    await presence.tick()
  })()
}

/** 从 package.json 读版本号；读不到给 '?'，不让它把插件搞挂。 */
function readVersion() {
  try {
    const url = new URL('./package.json', import.meta.url)
    return JSON.parse(readFileSync(url, 'utf8')).version || '?'
  } catch {
    return '?'
  }
}

export { sessionKey }
