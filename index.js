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
import { normalizeBindings, normalizeConfig } from './src/config.js'
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

/** 内存日志最多留几条。 */
const LOG_LIMIT = 80

/**
 * 每次心跳上报给 Java 的日志条数。
 *
 * <p>不报全部：心跳每 5 秒一次，报得越多请求体越大；
 * Java 那边展示的也是「最近发生了什么」，50 条够用。
 */
const LOG_UPLOAD_LIMIT = 50

/** 同一条错误多久之内只记一次（Java 没起来时避免刷屏）。 */
const FAILURE_LOG_INTERVAL_MS = 60_000

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const logs = []

  /**
   * 当前正在处理的 itemId（消息标识）。
   *
   * <p>作用：让「投递这条消息」过程中打的所有日志都带上同一个 id，
   * 这样 Java 侧的日志、这里的日志能用同一个 id 串起来（功能三）。
   * 由 inbound.js 在投递前设置、投递后清空。
   */
  let currentItemId = ''

  /**
   * 当前绑定从哪来：{@code 'local'} = cordis.patch.yml，{@code 'java'} = Java 设置页。
   *
   * <p>只用于日志，避免每次心跳都把同样一屏绑定刷一遍。
   */
  let bindingsSource = ''

  /**
   * 记账：写内存日志（结构化）+ 打到宿主 logger。
   *
   * @param {string} text  正文
   * @param {object} [options]
   * @param {'info'|'warn'|'error'} [options.level] 级别，默认 info
   * @param {string} [options.itemId] 关联的消息 id，默认用当前的
   */
  const log = (text, options = {}) => {
    const level = options.level || 'info'
    const itemId = options.itemId !== undefined ? String(options.itemId || '') : currentItemId

    const entry = { time: Date.now(), level, itemId, text }
    logs.push(entry)
    if (logs.length > LOG_LIMIT) logs.shift()

    try {
      // 宿主 logger 只有 info/warn/error 三个常用级别，debug 一律降到 info
      const host = level === 'error' ? ctx.logger?.error
        : level === 'warn' ? ctx.logger?.warn
          : ctx.logger?.info
      const line = `wdd-cat-linker: ${text}`
      if (typeof host === 'function') {
        host.call(ctx.logger, line)
      } else {
        ctx.logger?.info?.(line)
      }
    } catch {
      // logger 不可用不该影响主流程
    }
  }

  /** 在某个 itemId 的上下文里执行（投递过程用）。 */
  const withItemId = async (itemId, fn) => {
    const previous = currentItemId
    currentItemId = String(itemId || '')
    try {
      return await fn()
    } finally {
      currentItemId = previous
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
    log(text, { level: 'warn' })
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
    withItemId,
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

  /**
   * 从 Java 设置页拉绑定，覆盖本地那几条。
   *
   * <p>为什么这么做：绑定有两个来源，{@code cordis.patch.yml}（DSH 插件配置）
   * 和 Java 设置页。两边各存一份会互相打架——最终定成 **Java 说了算**：
   * 页面配过绑定就以页面为准，没配过才回退到本地配置。
   *
   * <p>{@code configured=false} 是关键：它区分「用户清空了绑定」和
   * 「用户从没碰过绑定」。前者必须真的停，后者才回退。
   */
  const refreshBindings = async () => {
    const remote = await bridge.get('/api/v1/settings/bindings')
    log("refreshBindings:"+remote)
    if (!remote || remote.configured !== true) {
      // 页面没配过：用本地 cordis.patch.yml 里写的
      if (bindingsSource !== 'local') {
        bindingsSource = 'local'
        log(`绑定来源：本地插件配置（${settings.bindings.length} 条）`)
      }
      return
    }
    const next = normalizeBindings(remote.bindings)
    const changed = JSON.stringify(next) !== JSON.stringify(settings.bindings)
    settings.bindings = next
    log("settings.bindings:"+settings.bindings)

    if (bindingsSource !== 'java' || changed) {
      bindingsSource = 'java'
      log(`绑定来源：Java 设置页（${next.length} 条）`)
      for (const binding of next) {
        const key = `${binding.chatType}:${binding.chatId}`
        log(`  ${key} → ${binding.target === 'session' ? '会话' : '工作区'}`
          + ` ${String(binding.target === 'session' ? binding.sessionId : binding.workspaceId).slice(-8)}`
          + `${binding.enabled === false ? '（已停用）' : ''}`)
      }
    }
  }

  /**
   * 当前真正能落到「活着的会话」的聊天。
   *
   * <p>返回 {@code null} 表示「这次别动清单」（见 publishPresence 的说明）。
   */
  const servedChats = () => {
    if (!settings.enabled) return []
    const chats = []
    for (const binding of settings.bindings) {
      if (binding.enabled === false) continue
      log("bindingxxxx:"+binding.sessionId+":"+binding.chatId)
      const resolved = resolver.resolveBinding(binding, settings.workspacePick)
      if (resolved.error) {
        log("resolved.error:"+resolved.error)
        
        continue}
      chats.push({ chatType: binding.chatType, chatId: binding.chatId })
    }
    return chats
  }

  /**
   * 采集候选清单：设置页的下拉框要用。
   *
   * <p>只有 DSH 知道这些；Java 拿不到，所以跟着心跳一起报过去。
   * 每次心跳都采一次——会话开关是动态的，缓存反而会让人看到过期状态。
   */
  const collectCandidates = () => {
    const live = new Set(resolver.liveSessionIds().map(sessionKey))
    const archived = resolver.archivedSessionKeys()

    const sessions = []
    const seen = new Set()
    for (const id of resolver.liveSessionIds()) {
      const key = sessionKey(id)
      if (!key || seen.has(key)) continue
      seen.add(key)
      sessions.push({
        id,
        title: resolver.sessionTitle(id),
        alive: live.has(key) && !archived.has(key),
      })
    }

    const workspaces = resolver.listWorkspaces().map((ws) => ({
      id: ws.id,
      title: ws.title,
      path: ws.path,
    }))

    return { sessions, workspaces }
  }

  /** 最近 {@link LOG_UPLOAD_LIMIT} 条日志，带上毫秒时间戳与 itemId。 */
  const recentLogs = () => logs.slice(-LOG_UPLOAD_LIMIT).map((entry) => ({
    time: entry.time,
    level: entry.level,
    itemId: entry.itemId || '',
    text: entry.text,
  }))

  /**
   * 心跳：先把绑定拉成最新的，再告诉 Java 要拉哪些聊天。
   *
   * <p>{@code chats} 有三种取值，语义完全不同（Java 侧据此分支）：
   * <ul>
   *   <li>{@code []}    — 明确关掉：总开关关了，或用户把绑定删光了；</li>
   *   <li>{@code null}  — 这次别动清单：有绑定但一条都解析不出活会话。
   *       典型场景是目标会话恰好没开着，这属于临时状态，
   *       不该把 Java 那边正在轮询的清单一次性清空；</li>
   *   <li>{@code [...]} — 正常，整体替换。</li>
   * </ul>
   */
  const publishPresence = async () => {
    try {
      await refreshBindings()
    } catch (error) {
      // 拉不到绑定不算致命：继续用上一份（或本地配置）发心跳
      reportFailure('拉取绑定失败（沿用上一份）：' + String((error && error.message) || error))
    }

    const chats = servedChats()
     log("chats:"+chats)

    const payloadChats = chats.length === 0 && settings.enabled && settings.bindings.length > 0
      ? null
      : chats

    try {
    log("payloadChats:"+payloadChats)

      await bridge.post('/api/v1/dsh/presence', {
        chats: payloadChats,
        candidates: collectCandidates(),
        logs: recentLogs(),
      })
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

  /**
   * 启动时打一份「我现在按谁说的干活」。
   *
   * <p>顺序很关键：先把 Java 设置页的绑定拉下来，再打印——
   * 否则日志会先显示本地那几条，几秒后又变成另一份，看起来像自己改了。
   */
  ;(async () => {
    try {
      await refreshBindings()
    } catch (error) {
      reportFailure('启动时拉取绑定失败（先用本地配置）：' + String((error && error.message) || error))
    }

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
      log(settings.enabled
        ? '绑定是空的——链路会停。去 Java 设置页 http://127.0.0.1:8080/settings 加一条'
        : '还没有绑定：在插件配置里加一条，或去 Java 设置页加（QQ 聊天 → 会话或工作区）')
    }
    if (!settings.enabled) {
      log('总开关是关的。调通之前建议先关着，确认无误再打开。')
    }

    // 立刻报一次 presence，不用等到第一个心跳
    await publishPresence()
  })()
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
