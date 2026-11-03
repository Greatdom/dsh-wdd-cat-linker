/**
 * 配置模型 —— 跳板侧唯一的数据契约。
 *
 * 只放 **DSH 侧的决策**：哪条 QQ 聊天对应哪间会话或工作区。
 * 节奏、限流、拆段、图片大小、人设等「怎么回」的策略全在 Java
 * （见 cat/src/main/resources/application.yml），改它们不必动这里。
 *
 * 所有函数都做「脏输入 → 干净输出」，调用方可以无条件信任字段类型。
 */

export const CHAT_PRIVATE = 'private'
export const CHAT_GROUP = 'group'

export const TARGET_SESSION = 'session'
export const TARGET_WORKSPACE = 'workspace'

export const DEFAULT_CONFIG = {
  /** 总闸。关着 = 完全不收发，装完不会动你的 QQ。 */
  enabled: false,

  /** Java 中转站地址。 */
  catBaseUrl: 'http://127.0.0.1:8080',
  /** 预留的共享密钥；留空表示中转站没开鉴权。 */
  catToken: '',

  /** 绑定表：一条 = 一个 QQ 聊天 → 一处 DSH 落点。 */
  bindings: [],
  /** 按工作区绑定时怎么挑会话：'recent' 最近有活动的 / 'first' 排序最前的。 */
  workspacePick: 'recent',

  /** DSH → QQ。 */
  relayOutbound: true,
  /** QQ → DSH。 */
  relayInbound: true,

  /** 心跳：告诉 Java「这些聊天现在要拉」的间隔。 */
  presenceIntervalMs: 5000,
  /** 轮询 Java 待投递队列的间隔。 */
  outboxPollMs: 1500,
  /** 单次 HTTP 请求超时。 */
  requestTimeoutMs: 5000,
}

/** 严格的布尔转换：只认明确的真假写法，其它回落默认值。 */
export function toBool(value, fallback) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/** 取整数并夹到 [min, max]；非法值回落 fallback。 */
export function toInt(value, fallback, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 取干净字符串。 */
export function toStr(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 规整一条绑定；不合格返回 null。
 *
 * 字段：chatType / chatId / target / sessionId / workspaceId / label / enabled
 */
export function normalizeBinding(raw) {
  if (!raw || typeof raw !== 'object') return null

  const chatType = raw.chatType === CHAT_GROUP ? CHAT_GROUP
    : (raw.chatType === CHAT_PRIVATE ? CHAT_PRIVATE : '')
  if (!chatType) return null

  const chatId = toStr(raw.chatId)
  // QQ 号 / 群号必须是纯数字
  if (!/^\d{4,15}$/.test(chatId)) return null

  const target = raw.target === TARGET_WORKSPACE ? TARGET_WORKSPACE : TARGET_SESSION
  const sessionId = toStr(raw.sessionId)
  const workspaceId = toStr(raw.workspaceId)
  if (target === TARGET_SESSION && !sessionId) return null
  if (target === TARGET_WORKSPACE && !workspaceId) return null

  return {
    chatType,
    chatId,
    target,
    sessionId: target === TARGET_SESSION ? sessionId : '',
    workspaceId: target === TARGET_WORKSPACE ? workspaceId : '',
    label: toStr(raw.label).slice(0, 40),
    enabled: toBool(raw.enabled, true),
  }
}

/** 绑定的唯一键，与 Java 侧 ChatKey 的线上格式一致。 */
export function chatKeyOf(binding) {
  return binding.chatType + ':' + binding.chatId
}

/**
 * 规整整个绑定表。
 *
 * 同一个聊天（chatType + chatId）只能绑一条——两条会互相抢消息。
 * 重复的保留第一条，后面的丢掉，不报错。
 */
export function normalizeBindings(raw) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(raw)) return out
  for (const item of raw.slice(0, 50)) {
    const binding = normalizeBinding(item)
    if (!binding) continue
    const key = chatKeyOf(binding)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(binding)
  }
  return out
}

/** 归一化整份配置。输入可以是任何东西，输出保证干净可用。 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...source }
  return {
    enabled: toBool(merged.enabled, DEFAULT_CONFIG.enabled),
    catBaseUrl: toStr(merged.catBaseUrl) || DEFAULT_CONFIG.catBaseUrl,
    catToken: toStr(merged.catToken),

    bindings: normalizeBindings(merged.bindings),
    workspacePick: merged.workspacePick === 'first' ? 'first' : 'recent',

    relayOutbound: toBool(merged.relayOutbound, DEFAULT_CONFIG.relayOutbound),
    relayInbound: toBool(merged.relayInbound, DEFAULT_CONFIG.relayInbound),

    presenceIntervalMs: toInt(merged.presenceIntervalMs, DEFAULT_CONFIG.presenceIntervalMs, 1000, 60000),
    outboxPollMs: toInt(merged.outboxPollMs, DEFAULT_CONFIG.outboxPollMs, 300, 30000),
    requestTimeoutMs: toInt(merged.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1000, 60000),
  }
}
