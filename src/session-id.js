/**
 * 会话 id 的归一化工具。
 *
 * 单独成文件是因为两个模块都要用：workspace.js 判归档/活会话，
 * resolver.js 做解析与反查。放这里避免它们互相 import 成环。
 *
 * ⚠ DSH 里存在 `xxx` 与 `session-xxx` 两种写法，所有比较前都必须过
 *   {@link sessionKey}，否则会静默匹配失败——列表里明明有，就是查不到。
 */

import { SESSION_PREFIX, SHORT_ID_LEN } from './constants.js'

/** 去掉前缀。 */
export function sessionKey(id) {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith(SESSION_PREFIX) ? s.slice(SESSION_PREFIX.length) : s
}

/** 两个 id 是否指向同一间会话（无视前缀差异）。 */
export function sameSession(a, b) {
  const ka = sessionKey(a)
  return ka !== '' && ka === sessionKey(b)
}

/** 短 id，用于日志与提示。 */
export function shortId(id) {
  return sessionKey(id).slice(-SHORT_ID_LEN)
}

/** 同一会话的两种写法，原始形态排在前。 */
export function idVariants(raw) {
  return raw.startsWith(SESSION_PREFIX)
    ? [raw, raw.slice(SESSION_PREFIX.length)]
    : [raw, SESSION_PREFIX + raw]
}
