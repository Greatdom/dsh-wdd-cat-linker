/**
 * 服务器连接桥,用来处理http请求
 */

import { REQUEST_TIMEOUT_MS } from '../common/constant.js'

export class BridgeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeError'
  }
}

export class Bridge {
  /**
   * @param {object} options
   * @param {string} options.baseUrl   中转站地址，例如 http://127.0.0.1:8080
   * @param {number} [options.timeoutMs] 单次请求超时
   */
  constructor({ baseUrl, timeoutMs = REQUEST_TIMEOUT_MS }) {
    this.base = String(baseUrl || '').trim().replace(/\/+$/, '')
    this.timeoutMs = Math.max(500, Number(timeoutMs) || REQUEST_TIMEOUT_MS)
  }

  get(path) {
    return this.#request('GET', path, undefined)
  }

  post(path, body) {
    return this.#request('POST', path, body === undefined ? {} : body)
  }

  async #request(method, path, body) {
    if (!this.base) {
      throw new BridgeError('没有配置中转站地址（catBaseUrl）')
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`请求超时（${this.timeoutMs}ms）`)),
      this.timeoutMs,
    )

    try {
      const headers = { accept: 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'

      const response = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })

      const text = await response.text()
      if (!response.ok) {
        throw new BridgeError(`${method} ${path} 返回 HTTP ${response.status}：${clip(text)}`)
      }
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch {
        throw new BridgeError(`${method} ${path} 的回包不是 JSON：${clip(text)}`)
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error
      throw new BridgeError(`${method} ${path} 失败：${String((error && error.message) || error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

function clip(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? flat.slice(0, 300) + '…' : flat
}
