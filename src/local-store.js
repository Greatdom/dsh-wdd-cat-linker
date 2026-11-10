/**
 * 跳板配置的本地持久化 + HTTP 读写接口。
 *
 * ---- 为什么从 Java 挪回来 ----
 *
 * 之前配置存在 Java（`/api/v1/linker/config`），问题是：
 *   · Java 没起来就读不到配置，连「改哪个地址」都改不了 —— 死锁；
 *   · 地址是「Java 在哪」，存在 Java 里本身就是循环依赖。
 *
 * 现在存在 DSH profile 的 `data/linker.json`，Host 端和设置页读同一份文件。
 *
 * ---- 为什么需要 HTTP 接口 ----
 *
 * 设置页跑在浏览器里，没有文件系统权限。它通过下面两条同源路由读写：
 *
 *   GET  /wdd-cat-linker/config   读当前配置
 *   POST /wdd-cat-linker/config   保存（**不校验 Java 是否可达**）
 *
 * 同源路由的好处：不发跨域请求，不需要 Java 那边放开 CORS。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 本插件在宿主上的路由前缀。 */
export const ROUTE_PREFIX = '/wdd-cat-linker'

/**
 * 允许设置页改的键。
 *
 * 与 {@link ../src/config.js} 的 DEFAULT_CONFIG 对应；
 * `bindings` 不在这里 —— 它由 Java 托管，跳板心跳时拉取。
 */
export const EDITABLE_KEYS = Object.freeze([
  'enabled',
  'catBaseUrl',
  'catToken',
  'workspacePick',
  'relayOutbound',
  'relayInbound',
  'presenceIntervalMs',
  'outboxPollMs',
  'requestTimeoutMs',
])

/**
 * 配置文件的位置。
 *
 * 优先用 cordis 给的 baseUrl（那是 profile 目录），
 * 拿不到就退到当前工作目录 —— 至少不会崩。
 *
 * @param {object} ctx cordis 上下文
 * @returns {string} 绝对路径
 */
export function configFilePath(ctx) {
  let base = null
  try {
    const url = ctx?.baseUrl || ctx?.fiber?.ctx?.baseUrl
    if (url) base = new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    // 拿不到就退到 cwd
  }
  if (!base) {
    base = process.cwd()
  }
  return join(base, 'data', 'linker.json')
}

/**
 * 本地配置存储。负责「读文件 / 写文件 / 合并到运行时配置」。
 */
export class LocalStore {
  /**
   * @param {object} deps
   * @param {string} deps.file      配置文件绝对路径
   * @param {object} deps.settings  运行时配置对象（可变，会被就地更新）
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ file, settings, log }) {
    this.file = file
    this.settings = settings
    this.log = log
    /** 上次成功写入的内容，用于「文件没变就别重复写」。 */
    this.lastWritten = ''
  }

  /** 从磁盘读一份（文件不存在或坏了就返回空对象）。 */
  readFile() {
    try {
      if (!existsSync(this.file)) return {}
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch (error) {
      this.log(`配置文件读不出来（${this.file}）：${String((error && error.message) || error)}`)
      return {}
    }
  }

  /** 把磁盘上的值合并进运行时配置。启动时和每次心跳都会调。 */
  applyFromFile() {
    const stored = this.readFile()
    const changed = []
    for (const key of EDITABLE_KEYS) {
      if (!(key in stored)) continue
      const next = stored[key]
      if (next === undefined || next === null) continue
      if (this.settings[key] === next) continue
      this.settings[key] = next
      changed.push(key)
    }
    if (changed.length) {
      this.log(`配置已从本地文件更新：${changed.join('、')}`)
    }
    return changed
  }

  /** 当前生效值（给设置页读）。 */
  snapshot() {
    const out = {}
    for (const key of EDITABLE_KEYS) out[key] = this.settings[key]
    return out
  }

  /**
   * 保存一份配置。
   *
   * **不校验 Java 是否可达** —— 这正是这次改动的目的：
   * 服务器没起来时用户依然要能改地址。
   *
   * @param {object} incoming 页面提交的键值
   * @returns {{ok: boolean, changed: number, values: object}}
   */
  save(incoming) {
    const stored = this.readFile()
    const merged = { ...stored }
    let changed = 0

    for (const key of EDITABLE_KEYS) {
      if (!incoming || !(key in incoming)) continue
      const value = coerce(key, incoming[key], this.settings[key])
      if (value === undefined) continue
      merged[key] = value
      changed++
    }

    // 就地更新运行时配置：保存完立刻生效，不用等下一次心跳
    for (const key of EDITABLE_KEYS) {
      if (key in merged && this.settings[key] !== merged[key]) {
        this.settings[key] = merged[key]
      }
    }

    this.#persist(merged)
    return { ok: true, changed, values: this.snapshot() }
  }

  /** 原子写：先写临时文件再 rename，避免写一半崩掉留下坏文件。 */
  #persist(data) {
    const text = JSON.stringify(data, null, 2)
    if (text === this.lastWritten) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, this.file)
      this.lastWritten = text
      this.log(`配置已保存到 ${this.file}`)
    } catch (error) {
      this.log(`配置保存失败：${String((error && error.message) || error)}`)
    }
  }
}

/**
 * 按当前值的类型转换一遍，避免页面传字符串导致下游判断失效。
 *
 * @returns {*} 转换后的值；非法则 undefined（保持原值）
 */
function coerce(key, raw, current) {
  if (raw === undefined || raw === null) return undefined

  if (typeof current === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const s = String(raw).trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
    return undefined
  }

  if (typeof current === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (!Number.isFinite(n)) return undefined
    return clamp(key, Math.round(n))
  }

  return String(raw).trim()
}

/** 与 config.js 的 normalizeConfig 保持同一组区间。 */
function clamp(key, value) {
  switch (key) {
    case 'presenceIntervalMs':
      return Math.max(1000, Math.min(60000, value))
    case 'outboxPollMs':
      return Math.max(300, Math.min(30000, value))
    case 'requestTimeoutMs':
      return Math.max(1000, Math.min(60000, value))
    default:
      return value
  }
}

/**
 * 在宿主上注册配置读写路由。
 *
 * @param {object} ctx    cordis 上下文（需要 webServer）
 * @param {LocalStore} store
 * @returns {Function|undefined} 清理函数；宿主没提供 webServer 时返回 undefined
 */
export function registerRoutes(ctx, store) {
  let web = null
  try {
    web = ctx.get?.('webServer') || ctx.webServer
  } catch {
    web = null
  }
  if (!web || typeof web.register !== 'function') {
    return undefined
  }

  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        // 1MB 上限：配置就是几个数字和一个地址，超过必然是异常输入
        if (size > 1024 * 1024) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text ? JSON.parse(text) : {})
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })

  const dispose = web.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/config`,
    handler: (req, res) => {
      void (async () => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          json(res, 200, { values: store.snapshot(), editable: EDITABLE_KEYS })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (body === null) {
            json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          json(res, 200, store.save(body))
          return
        }
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      })()
    },
  })

  return dispose
}
