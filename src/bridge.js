/**
 * 通往 Java 中转站的 HTTP 客户端。
 *
 * 方向很重要：**只有跳板 → Java 这一个方向**。Java 从不回调 DSH 宿主的 HTTP 服务，
 * 因为宿主对非 Electron 渲染进程的请求默认返回 403（"Browser access is disabled"），
 * 反向调用会直接撞墙。契约只朝一个方向设计，就没有这个坑。
 *
 * 失败一律抛 {@link BridgeError}，由调用方决定「重试下一轮」还是「记账跳过」——
 * 这里不吞异常，也不自己做重试循环（重试策略属于调用方语义）。
 */

export class BridgeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeError'
  }
}

export class Bridge {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  中转站地址，例如 http://127.0.0.1:8080
   * @param {string} [options.token]  预留的共享密钥，留空则不发 Authorization
   * @param {number} [options.timeoutMs] 单次请求超时
   */
  constructor({ baseUrl, token = '', timeoutMs = 5000 }) {
    this.reconfigure({ baseUrl, token, timeoutMs })
  }

  /**
   * 换地址/令牌/超时。
   *
   * 为什么需要：中转站地址可以在设置页改，而 Bridge 是构造时创建的。
   * 让它可以就地改，比销毁重建整条链路简单得多。
   */
  reconfigure({ baseUrl, token = '', timeoutMs = 5000 }) {
    this.base = String(baseUrl || '').trim().replace(/\/+$/, '')
    this.token = String(token || '').trim()
    this.timeoutMs = Math.max(500, Number(timeoutMs) || 5000)
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
    const url = this.base + path
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`请求超时（${this.timeoutMs}ms）`)),
      this.timeoutMs,
    )

    try {
      const headers = { accept: 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (this.token) headers.authorization = `Bearer ${this.token}`

      const response = await fetch(url, {
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
