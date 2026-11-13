/**
 * 配置模型 —— 跳板侧唯一的数据契约。
 *
 * 只放 **DSH 侧的接线决策**：中转站在哪、开不开收发、节奏多快。
 *
 * ---- 存档制度下的变化 ----
 *
 * 原来的 `bindings`（QQ 聊天 → DSH 落点）已经**整个删掉**：
 * 存档由 Java 完全托管，跳板只在内存里缓存一份（见 archives.js）。
 * 配置里留存档会造成两个来源打架——这是当初绑定托管就踩过的坑。
 *
 * `workspacePick` 也删了：存档只能绑「一间明确的会话」，不再有「在工作区里自动挑」。
 *
 * 所有函数都做「脏输入 → 干净输出」，调用方可以无条件信任字段类型。
 */

export const CHAT_PRIVATE = 'private'
export const CHAT_GROUP = 'group'

/** 通道类型 —— 与 Java 侧的 ChannelKind 对应。 */
export const CHANNEL_QQ = 'QQ'
export const CHANNEL_INTERNAL = 'INTERNAL'

export const DEFAULT_CONFIG = {
  /** 总闸。关着 = 完全不收发，装完不会动你的 QQ。 */
  enabled: false,

  /** Java 中转站地址。 */
  catBaseUrl: 'http://127.0.0.1:8080',
  /** 预留的共享密钥；留空表示中转站没开鉴权。 */
  catToken: '',

  /** DSH → QQ。 */
  relayOutbound: true,
  /** QQ → DSH。 */
  relayInbound: true,

  /** 心跳：告诉 Java「这些存档现在要服务」的间隔。 */
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

/** 聊天的唯一键，与 Java 侧 ChatKey 的线上格式一致。 */
export function chatKeyOf(chatType, chatId) {
  return chatType + ':' + chatId
}

/**
 * 归一化整份配置。输入可以是任何东西，输出保证干净可用。
 *
 * <p>注意：这里**不处理存档**——存档完全由 Java 托管。
 * 如果 profile 的 cordis.patch.yml 里还留着旧的 `bindings`，会被忽略。
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...source }
  return {
    enabled: toBool(merged.enabled, DEFAULT_CONFIG.enabled),
    catBaseUrl: toStr(merged.catBaseUrl) || DEFAULT_CONFIG.catBaseUrl,
    catToken: toStr(merged.catToken),

    relayOutbound: toBool(merged.relayOutbound, DEFAULT_CONFIG.relayOutbound),
    relayInbound: toBool(merged.relayInbound, DEFAULT_CONFIG.relayInbound),

    presenceIntervalMs: toInt(merged.presenceIntervalMs, DEFAULT_CONFIG.presenceIntervalMs, 1000, 60000),
    outboxPollMs: toInt(merged.outboxPollMs, DEFAULT_CONFIG.outboxPollMs, 300, 30000),
    requestTimeoutMs: toInt(merged.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1000, 60000),
  }
}
