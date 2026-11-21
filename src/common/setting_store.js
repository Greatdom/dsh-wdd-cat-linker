/** 跳板本地配置管理*/

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件在宿主上的路由前缀。 */
export const ROUTE_PREFIX = '/wdd-cat-linker'

/** 配置路由。 */
export const CONFIG_PATH = ROUTE_PREFIX + '/config'

/** 样式路由。 */
export const STYLE_PATH = ROUTE_PREFIX + '/style'

/** 设置页样式文件：src/asset/settings.css，相对本文件定位。 */
const STYLE_FILE = fileURLToPath(new URL('../asset/settings.css', import.meta.url))

/**
 * 读设置页样式文本
 */
export function readStyleText() {
  try {
    return readFileSync(STYLE_FILE, 'utf8')
  } catch {
    return null
  }
}

/**
 * 允许设置页改的键。
 */
export const EDITABLE_KEYS = Object.freeze([
  'enabled',
  'catBaseUrl',
  'relayOutbound',
  'relayInbound',
  'heartbeatIntervalMs',
  'inboundIntervalMs',
  'requestTimeoutMs',
  'logUploadLimit',
  'outboundFailTtlMs',
])

/**
 * 配置文件位置。
 */
export function configFilePath(ctx) {
  let base = null
  try {
    const url = ctx?.baseUrl || ctx?.fiber?.ctx?.baseUrl
    if (url) base = new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    // 拿不到就退到工作目录
  }
  if (!base) {
    base = process.cwd()
  }
  return join(base, 'data', 'linker.json')
}

/**
 * 本地配置存储器
 */
export class LocalStore {
  constructor({ file, settings, log }) {
    this.file = file
    this.settings = settings
    this.log = log
  }

  read() {
    if (!existsSync(this.file)) {
      return {}
    }
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
      }
      // 只认还认识的键,老文件里可能有已经删掉的项
      const out = {}
      for (const key of EDITABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          out[key] = parsed[key]
        }
      }
      return out
    } catch (error) {
      this.log('读 linker.json 失败（走默认值）：' + String((error && error.message) || error))
      return {}
    }
  }

  /** 启动时调一次。 */
  hydrate() {
    const stored = this.read()
    const keys = Object.keys(stored)
    if (!keys.length) {
      return
    }
    for (const key of keys) {
      this.settings[key] = stored[key]
    }
    this.log(`已载入 ${keys.length} 项本地配置`)
  }

  /** 当前配置的可编辑视图 */
  snapshot() {
    const out = {}
    for (const key of EDITABLE_KEYS) {
      out[key] = this.settings[key]
    }
    return out
  }

  /**
   * 读一项当前值。
   *
   * 给「需要在运行时按最新设置工作」的模块用（比如心跳每轮现读上报条数）。
   * 返回的是 this.settings 上的实时值：设置页保存后立刻能读到新值，不用重启。
   */
  get(key) {
    return this.settings[key]
  }

 
  save(incoming) {
    if (!incoming || typeof incoming !== 'object') {
      return { changed: 0, values: this.snapshot() }
    }
    const next = this.read()
    let changed = 0
    for (const key of EDITABLE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) {
        continue
      }
      const value = normalize(key, incoming[key])
      if (value === undefined) {
        continue
      }
      next[key] = value
      this.settings[key] = value
      changed++
    }
    if (changed > 0) {
      this.#persist(next)
    }
    return { changed, values: this.snapshot() }
  }

  /** 落盘 */
  #persist(data) {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('写 linker.json 失败：' + String((error && error.message) || error))
    }
  }
}

/** 各键的类型与区间。 */
const SPEC = {
  enabled: { type: 'bool' },
  catBaseUrl: { type: 'string' },
  relayOutbound: { type: 'bool' },
  relayInbound: { type: 'bool' },
  heartbeatIntervalMs: { type: 'number', min: 1000, max: 60000 },
  inboundIntervalMs: { type: 'number', min: 300, max: 30000 },
  requestTimeoutMs: { type: 'number', min: 1000, max: 60000 },
  logUploadLimit: { type: 'number', min: 10, max: 200 },
  outboundFailTtlMs: { type: 'number', min: 5000, max: 600000 },
}

/** 按类型规整 */
function normalize(key, raw) {
  const spec = SPEC[key]
  if (!spec) {
    return undefined
  }
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
  }
  if (spec.type === 'string') {
    return raw == null ? '' : String(raw).trim()
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return undefined
  }
  return Math.max(spec.min, Math.min(spec.max, Math.round(n)))
}

/**
 * 在宿主上注册配置读写路由
 */
export function registerRoutes(webCtx, store) {
  const webServer = webCtx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    return undefined
  }

  /** 配置读写。 */
  const configHandler = (req, res) => {
    const json = (status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET') {
      json(200, { ok: true, values: store.snapshot() })
      return
    }
    if (req.method !== 'POST') {
      json(405, { ok: false, error: 'method not allowed' })
      return
    }

    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        json(400, { ok: false, error: 'body is not JSON' })
        return
      }
      const result = store.save(body)
      json(200, { ok: true, changed: result.changed, values: result.values })
    })
    req.on('error', () => {
      json(400, { ok: false, error: 'request aborted' })
    })
  }

  /** 样式阅读器 */
  const styleHandler = (_req, res) => {
    const css = readStyleText()
    res.statusCode = css === null ? 404 : 200
    res.setHeader('content-type', 'text/css; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(css === null ? '/* settings.css 读不到 */' : css)
  }

  const disposers = []
  disposers.push(webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: configHandler }))
  disposers.push(webServer.register({ kind: 'exact', path: STYLE_PATH, handler: styleHandler }))

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // ignore
      }
    }
  }
}
