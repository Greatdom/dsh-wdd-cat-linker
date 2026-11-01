/**
 * DSH ↔ QQ 跳板（dsh-wdd-cat-linker）—— 插件入口。
 *
 * 本文件只做**装配**，不含业务判断。职责切分：
 *
 *   跳板（这里 + src/）只做四件事：
 *     ① 出站监听：assistant/message 攒、turn/end(completed) 上报给 Java；
 *     ② 入站投递：取 Java 的待投递队列 → followup 进会话 → ack；
 *     ③ 落点解析：绑定（QQ 聊天 ↔ 会话/工作区）→ 一间活着的会话；
 *     ④ 心跳：告诉 Java「这些聊天现在归我负责」。
 *
 *   Java 中转站（cat）承担全部业务：OneBot 通信、消息段翻译、合并转发、
 *   攒批、限流、拆段节奏、图片字节处理、身份与提示词渲染。
 *
 * 想改「它怎么说话、多久回、回几条」，去改 Java 的 application.yml —— 不用动这里。
 *
 * src/ 下的分工：
 *   src/config.js    配置模型（只含 DSH 侧决策）
 *   src/bridge.js    通往 Java 的 HTTP（唯一出口，单向）
 *   src/resolver.js  绑定 → 活着的会话（session- 前缀归一化等坑都在这里）
 *   src/media.js     纯函数：抽文本、抽图、路径解析、读 base64
 *   src/outbound.js  DSH → Java
 *   src/inbound.js   Java → DSH
 */

import { readFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

import { Bridge } from './src/bridge.js'
import { normalizeConfig } from './src/config.js'
import { Inbound } from './src/inbound.js'
import { Outbound } from './src/outbound.js'
import { SessionResolver, sessionKey } from './src/resolver.js'

/** 插件名（cordis 用它做去重/卸载标识）。 */
export const name = 'dsh-wdd-cat-linker'

/**
 * 依赖注入清单。少一个都会让插件不激活，所以只列真正用到的。
 *
 *   agents            按 sessionId 拿活着的 agent → followup 投递
 *   sessions          按工作区绑定时读活动时间，用来挑「最近那间」
 *   sessionTitle      日志里显示会话叫什么
 *   timer             ctx.interval 心跳
 *   workspaceRegistry 工作区清单 / 归档名单
 *   attachments       图片准入与宿主路径
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
  enabled: Schema.boolean().default(false).description('总开关。关着 = 完全不收发'),
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

/** 内存日志最多留几条。 */
const LOG_LIMIT = 80

/** 同一条错误多久之内只记一次（Java 没起来时避免刷屏）。 */
const FAILURE_LOG_INTERVAL_MS = 60_000

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const logs = []

  /** 记账：写内存日志 + 打到宿主 logger。 */
  const log = (text) => {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    logs.push({ time, text })
    if (logs.length > LOG_LIMIT) logs.shift()
    try {
      ctx.logger?.info(`wdd-cat-linker: ${text}`)
    } catch {
      // logger 不可用不该影响主流程
    }
  }

  /** Java 长时间不可达时不要每 5 秒刷一条同样的错误。 */
  let lastFailure = null
  const reportFailure = (text) => {
    const now = Date.now()
    if (lastFailure && lastFailure.text === text && now - lastFailure.at < FAILURE_LOG_INTERVAL_MS) {
      return
    }
    lastFailure = { text, at: now }
    log(text)
  }

  const resolver = new SessionResolver(ctx)
  const bridge = new Bridge({
    baseUrl: settings.catBaseUrl,
    token: settings.catToken,
    timeoutMs: settings.requestTimeoutMs,
  })

  /** 取 DSH 的 attachments 服务（图片准入 / 宿主路径）。 */
  const attachmentsService = () => {
    try {
      return ctx.get?.('attachments') || ctx.attachments
    } catch {
      return undefined
    }
  }

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

  // ─────────────────────────── ③ 心跳：告诉 Java 要拉哪些聊天 ───────────────────────────

  /** 当前真正能落到「活着的会话」的聊天。 */
  const servedChats = () => {
    if (!settings.enabled) return []
    const chats = []
    for (const binding of settings.bindings) {
      if (binding.enabled === false) continue
      const resolved = resolver.resolveBinding(binding, settings.workspacePick)
      if (resolved.error) continue
      chats.push({ chatType: binding.chatType, chatId: binding.chatId })
    }
    return chats
  }

  const publishPresence = async () => {
    const chats = servedChats()
    try {
      await bridge.post('/api/v1/dsh/presence', { chats })
    } catch (error) {
      reportFailure('上报 presence 失败（Java 中转站没起来？）：'
        + String((error && error.message) || error))
    }
  }

  // ─────────────────────────── ① 出站：监听会话事件 ───────────────────────────

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

  // ─────────────────────────── ② 入站：轮询待投递队列 ───────────────────────────

  if (typeof ctx.interval !== 'function') {
    log('宿主没提供 timer（ctx.interval 不存在）—— QQ → DSH 收不到消息，DSH → QQ 也不可用')
  } else {
    // ⚠ ctx.interval 内部已用 ctx.effect 托管清理，**不要**再包一层 ctx.effect，
    //   重复包会让它注册两次。
    ctx.interval(() => {
      void publishPresence()
    }, settings.presenceIntervalMs)

    ctx.interval(() => {
      void inbound.tick()
    }, settings.outboxPollMs)
  }

  // 卸载时停掉投递并清缓存
  ctx.effect(() => () => {
    inbound.dispose()
    outbound.dispose()
  }, 'wdd-cat-linker: 卸载清理')

  // ─────────────────────────── 启动 ───────────────────────────

  log(`已装好 v${readVersion()}｜总开关 ${settings.enabled ? '开' : '关'}`
    + `｜绑定 ${settings.bindings.length} 条`
    + `｜中转站 ${settings.catBaseUrl}`)

  for (const binding of settings.bindings) {
    const key = `${binding.chatType}:${binding.chatId}`
    if (binding.enabled === false) {
      log(`  ${key} →（已停用）`)
      continue
    }
    const resolved = resolver.resolveBinding(binding, settings.workspacePick)
    if (resolved.error) {
      log(`  ${key} → ⚠ ${resolved.error}`)
    } else {
      log(`  ${key} → ${resolver.sessionTitle(resolved.sessionId)}（${resolved.reason}）`)
    }
  }

  if (settings.bindings.length === 0) {
    log('还没有绑定：在插件配置里加一条（QQ 聊天 → 会话或工作区）')
  }
  if (!settings.enabled) {
    log('总开关是关的。调通之前建议先关着，确认无误再打开。')
  }

  // 立刻报一次 presence，不用等到第一个心跳
  void publishPresence()
}

/** 从 package.json 读版本号（读不到给 '?'，不让它把插件搞挂）。 */
function readVersion() {
  try {
    const url = new URL('./package.json', import.meta.url)
    return JSON.parse(readFileSync(url, 'utf8')).version || '?'
  } catch {
    return '?'
  }
}

/** 便于排查：暴露当前服务中的聊天键（未使用，保留给将来的设置页）。 */
export function describeServedChats(config) {
  const settings = normalizeConfig(config)
  return settings.bindings.map((binding) => `${binding.chatType}:${binding.chatId}`)
}

export { sessionKey }
