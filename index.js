/**
 * DSH ↔ 服务器跳板 —— 插件入口。
 *
 * 本文件只做装配，不含业务判断：
 *   ① 心跳：告诉 Java「这些会话我能服务」；
 *   ② 入站：取 Java 队列 → ack → followup 进 DSH 会话；
 *   ③ 存档快照：从 Java 拉一份只读缓存。
 *
 * Java 中转站（cat）承担全部业务：OneBot 通信、消息段翻译、合并、
 * 攒批、限流、图片处理、身份与提示词渲染。
 */

import Schema from '@deepseek-ai/schemastery'

import { Heartbeat } from './src/linker/heartbeat.js'
import { Inbound } from './src/linker/inbound.js'
import { Bridge } from './src/linker/bridge.js'
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
export const inject = ['agents', 'timer']

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
//注册相关插件,其中:

//当接收到消息之后缓存到池子里并向中转站返回到ack
//注册一个工具,这个工具强制让dsh输出成能够和InboundMessage组装成E:\程序代码\dsh\cat\src\main\java\com\wdd\cat\message\child\OutboundMessage.java的格式的json
// (当然并不是和真正的outboundMessage完全匹配,因为业务在回复完成后还要和原来的InboundMessage拼接成完整的数据结构)
//推理之前强制抹除原来的上下文及其历史并根据InboundMessage的内容注入新的提示词
//如果dsh在推理中检测到可能要调用到日程工具或者记忆工具,就要拦截掉并根据从中转站得到的渠道能力自行在json回复中追加送往特定渠道的消息
//例如如果模型推理检测到要加日程,那么在调用内置日程根据时根据代码被拦截并根据渠道能力表强制在json追加某个叫做ADD_DATE的渠道的NormalMessage并入OutboundMessage
//最后将模型输出的json转换成期望的数据结构,先缓存到出站缓冲池,,接着送回中转站处理

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

  // ── 三个业务件 ────────────────────────────────────────────
  const heartbeat = new Heartbeat({ bridge, finder, log })
  const inbound = new Inbound({ bridge, finder, log })

  if (typeof ctx.interval !== 'function') {
    log('宿主没提供 timer（ctx.interval 不存在）—— QQ → DSH 收不到消息')
    return
  }

  // ── 定时器 ────────────────────────────────────────────────
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

  // 存档快照变化不快，跟着心跳节奏刷就行
  ctx.interval(() => {
    if (!settings.enabled) return
  }, settings.heartbeatIntervalMs * 6)

  // ── 卸载清理 ──────────────────────────────────────────────
  ctx.effect(() => () => {
    heartbeat.dispose()
    inbound.dispose()
  }, 'dsh-wdd-cat-linker: 卸载清理')

  // ── 启动：拉一次存档、立刻报一次心跳 ──────────────────────
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
