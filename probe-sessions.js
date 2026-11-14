// /**
//  * 探针：列出 DSH 宿主里能拿到哪些「会话」。
//  *
//  * 用途：改「存档会话下拉框」之前，确认哪条路能拿到**全部会话**（不是只有活 agent 的）。
//  *
//  * 用法：复制到 node_modules 后重启 DSH，看日志里 `[probe-sessions]` 开头的行。
//  */

// export const name = 'dsh-wdd-cat-linker-probe'

// export const inject = ['sessions', 'workspaceRegistry', 'sessionTitle']

// export function apply(ctx) {
//   const log = (msg) => {
//     try { ctx.logger.info(`[probe-sessions] ${msg}`) } catch { /* ignore */ }
//   }

//   const safe = (label, fn) => {
//     try {
//       return fn()
//     } catch (e) {
//       log(`${label} 抛错: ${e && e.message}`)
//       return undefined
//     }
//   }

//   setTimeout(() => {
//     const sessions = safe('ctx.sessions', () => ctx.get('sessions') || ctx.sessions)
//     log(`sessions 服务: ${sessions ? '有' : '无'}`)
//     if (sessions) {
//       const keys = Object.keys(sessions).filter((k) => typeof sessions[k] === 'function')
//       log(`sessions 上的方法: ${keys.join(', ') || '(无)'}`)
//       if (typeof sessions.list === 'function') {
//         const list = safe('sessions.list()', () => sessions.list())
//         log(`sessions.list() 返回 ${Array.isArray(list) ? list.length : typeof list} 条`)
//         if (Array.isArray(list) && list.length) {
//           const s = list[0]
//           log(`第一项字段: ${Object.keys(s || {}).join(', ')}`)
//         }
//       }
//     }

//     const registry = safe('workspaceRegistry', () => ctx.get('workspaceRegistry') || ctx.workspaceRegistry)
//     log(`workspaceRegistry 服务: ${registry ? '有' : '无'}`)
//     if (registry && typeof registry.list === 'function') {
//       const ws = safe('workspaceRegistry.list()', () => registry.list()) || []
//       log(`工作区 ${ws.length} 个`)
//       for (const w of ws) {
//         const ids = Array.isArray(w.sessionIds) ? w.sessionIds : []
//         log(`  工作区「${w.title}」 sessionIds=${ids.length} 个`)
//       }
//     }

//     const agents = safe('agents', () => ctx.get('agents') || ctx.agents)
//     if (agents && typeof agents.list === 'function') {
//       const list = safe('agents.list()', () => agents.list()) || []
//       log(`活 agent: ${list.length} 个`)
//       for (const a of list) {
//         const id = (a && a.session && a.session.id) || (a && a.sessionId)
//         log(`  agent 会话 id: ${id}`)
//       }
//     }
//   }, 3000)
// }
