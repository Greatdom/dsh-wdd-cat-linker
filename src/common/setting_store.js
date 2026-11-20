/** 跳板本地配置持久化;不从java读取配置,因为跳板配置和中转站服务器的配置是独立的 */

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
 * 读设置页样式文本；读不到返回 null。
 * <p>每次现读不缓存：改完 css 刷新页面就能看到，不用重启 DSH。
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
 * <p>存档不在这里：它由 Java 完全托管（/archives 页面），跳板只读不存。
 */
export const EDITABLE_KEYS = Object.freeze([
  'enabled',
  'catBaseUrl',
  'relayOutbound',
  'relayInbound',
  'heartbeatIntervalMs',
  'inboundIntervalMs',
  'requestTimeoutMs',
])

/**
 * 配置文件位置。
 * <p>优先用 cordis 给的 baseUrl（那是 profile 目录），拿不到就退到 cwd。
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
 * 本地配置存储：读文件 / 写文件 / 合并到运行时配置。
 *
 * <p>为什么不存 Java：地址是「Java 在哪」，存在 Java 里就是循环依赖 ——
 * Java 没起来时连「改哪个地址」都改不了。
 */
export class LocalStore {
  /**
   * @param {object} deps
   * @param {string} deps.file     配置文件绝对路径
   * @param {object} deps.settings 运行时配置（可变，会被就地更新）
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ file, settings, log }) {
    this.file = file
    this.settings = settings
    this.log = log
  }

  /** 读磁盘上的覆盖值；没有返回空对象。 */
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
      // 只认还认识的键：老文件里可能有已经删掉的项
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

  /** 把磁盘上的值合并进运行时配置。启动时调一次。 */
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

  /** 当前配置的可编辑视图。 */
  snapshot() {
    const out = {}
    for (const key of EDITABLE_KEYS) {
      out[key] = this.settings[key]
    }
    return out
  }

  /**
   * 保存：只收白名单里的键，值会做类型规整和区间夹取。
   *
   * @param {object} incoming
   * @returns {{changed: number, values: object}}
   */
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

  /** 写盘。失败只记日志，不阻断。 */
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
}

/** 按类型规整；不合法返回 undefined（表示跳过）。 */
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
 * 在宿主上注册配置读写路由。
 *
 * <p>⚠ 宿主的 webServer <b>不是 Express</b>，没有 use()。它的形状是：
 * <pre>
 *   webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })
 *   → 返回 disposer
 * </pre>
 * handler 收的是 Node 原生的 IncomingMessage / ServerResponse，
 * 所以路由匹配和 body 解析都得自己做。
 *
 * <p>为什么要自己注册路由而不是让页面直接打 Java：配置是「Java 在哪」，
 * 让页面跨域去 Java 读，Java 没起来就死锁。
 *
 * @param {object} webCtx   已经拿到 webServer 的 cordis 上下文
 * @param {LocalStore} store
 * @returns {(() => void) | undefined} 解绑函数
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

  /** 样式：把 asset/settings.css 原样吐出去。 */
  const styleHandler = (_req, res) => {
    const css = readStyleText()
    res.statusCode = css === null ? 404 : 200
    res.setHeader('content-type', 'text/css; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(css === null ? '/* settings.css 读不到 */' : css)
  }

  // exact：只认这两个路径，不吞掉别的
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
