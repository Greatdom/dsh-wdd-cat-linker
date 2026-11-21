/**
 * 设置插槽
 */

window.__ModuleLoader__.load({
  // 模块身份 = 包名，必须与 package.json 的 name 一致
  id: 'dsh-wdd-cat-linker',

  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 配置读写路径 */
    const CONFIG_PATH = '/wdd-cat-linker/config'

    // ── 取值 ────────────────────────────────────────────────

    /** 读；失败返回 null，不抛,因为页面不该因为一次网络抖动白屏。 */
    const get = (path) =>
      fetch(path, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)

    /** 写。 */
    const post = (path, body) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)

    /**
     * 探测中转站是否可达。
     */
    async function probeServer(baseUrl) {
      const base = String(baseUrl || '').trim().replace(/\/+$/, '')
      if (!base) return { ok: false, detail: '还没填地址' }

      let url
      try {
        url = new URL('/api/health', base).toString()
      } catch {
        return { ok: false, detail: '地址格式不对，示例: http://127.0.0.1:8080' }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!res.ok) {
          return { ok: false, detail: `服务器有响应但状态码是 ${res.status}` }
        }
        const body = await res.json().catch(() => null)
        const msg = body && body.data ? String(body.data) : 'ok'
        return { ok: true, detail: `中转站在线（${msg}）` }
      } catch (error) {
        const text = String((error && error.message) || error)
        if (controller.signal.aborted) {
          return { ok: false, detail: '连接超时（4 秒没响应）' }
        }
        return { ok: false, detail: `连不上：${text}` }
      } finally {
        clearTimeout(timer)
      }
    }

    // ── 字段定义（决定表单长什么样）────────────────────────

    const FIELDS = [
      { group: '基本', key: 'catBaseUrl', label: 'cat 服务器地址', hint: '本地 Java 业务中转站，如 http://127.0.0.1:8080', type: 'text' },

      { group: '收发开关', key: 'enabled', label: '总开关', hint: '关掉 = 完全不收发', type: 'bool' },
      { key: 'relayOutbound', label: 'DSH → cat 服务器', hint: '模型交卷后把回复推回 cat 服务器，由它转发到外部聊天', type: 'bool' },
      { key: 'relayInbound', label: 'cat 服务器 → DSH', hint: '取 cat 服务器队列里的消息投进 DSH 会话', type: 'bool' },

      { group: '节奏', key: 'heartbeatIntervalMs', label: '心跳间隔（毫秒）', hint: '1000~60000', type: 'number', min: 1000, max: 60000 },
      { key: 'inboundIntervalMs', label: '拉队列间隔（毫秒）', hint: '300~30000', type: 'number', min: 300, max: 30000 },
      { key: 'requestTimeoutMs', label: '请求超时（毫秒）', hint: '1000~60000', type: 'number', min: 1000, max: 60000 },

      { group: '日志', key: 'logUploadLimit', label: '每次上报日志条数', hint: '跟着心跳发给中转站，10~200；改完下一跳生效', type: 'number', min: 10, max: 200 },
    ]

    // ── 样式 ────────────────────────────────────────────────

    const STYLE_PATH = '/wdd-cat-linker/style'
    const STYLE_ID = 'cat-linker-settings-style'

    /** 样式兜底 */
    const FALLBACK_CSS = `
      .ck-wrap{padding:16px 18px 24px;font-size:13px;line-height:1.7;max-width:760px}
      .ck-title{font-size:18px;font-weight:600;margin:0 0 4px}
      .ck-desc{margin:0 0 16px;font-size:13px;opacity:.65}
      .ck-card{border:1px solid rgba(0,0,0,.1);border-radius:10px;padding:12px 14px;margin-bottom:12px}
      .ck-group-title{font-size:13px;font-weight:600;margin:0 0 10px;opacity:.85}
      .ck-row{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;flex-wrap:wrap}
      .ck-lab{flex:0 0 170px;padding-top:3px;font-size:12.5px}
      .ck-ctl{flex:1 1 260px;min-width:200px}
      .ck-hint{opacity:.6;font-size:11.5px;margin-top:2px}
      .ck-input{border:1px solid rgba(0,0,0,.14);border-radius:6px;padding:4px 8px;background:transparent;color:inherit;font-size:12.5px;width:100%;box-sizing:border-box}
      .ck-bar{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border-radius:10px;border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.96);box-shadow:0 -4px 14px rgba(0,0,0,.12);margin-top:12px}
      .ck-btn,.ck-btn-primary{border-radius:6px;padding:5px 14px;font-size:12.5px;cursor:pointer}
      .ck-btn{background:transparent;color:inherit;border:1px solid rgba(0,0,0,.14)}
      .ck-btn-primary{background:#4a7dff;border:1px solid #4a7dff;color:#fff}
      .ck-ok{color:#4a7dff;font-size:12px}
      .ck-err{color:#c0392b;font-size:12px}
      .ck-dirty{color:#c0392b;font-size:12px;font-weight:600}
      .ck-probe{padding:8px 12px;margin-bottom:12px;border-radius:8px;font-size:12.5px}
    `

    let styleText = null

    /** 把 CSS 插进 <head>；已经有了就复用同一个 <style>。 */
    function injectStyle(text) {
      if (!text || typeof document === 'undefined') return
      const head = document.head || document.getElementsByTagName('head')[0]
      if (!head) return
      let el = document.getElementById(STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = STYLE_ID
        head.appendChild(el)
      }
      if (el.textContent !== text) el.textContent = text
    }

    /** 取样式文本：优先走宿主同源路由，拿不到用兜底。 */
    async function loadStyle() {
      if (styleText) return styleText
      try {
        const res = await fetch(STYLE_PATH, { cache: 'no-store' })
        if (res.ok) {
          const text = await res.text()
          if (text && text.trim()) styleText = text
        }
      } catch {
        // 路由不通，用兜底
      }
      if (!styleText) styleText = FALLBACK_CSS
      return styleText
    }

    // ── 组件 ────────────────────────────────────────────────

    function LinkerSection() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [loadError, setLoadError] = React.useState('')
      /** 最近一次连接探测的结果：null = 还没测 */
      const [probe, setProbe] = React.useState(null)

      /** 测一次中转站，把结果记进状态。 */
      const runProbe = async (baseUrl) => {
        const result = await probeServer(baseUrl)
        setProbe(result)
        return result
      }

      // 首次拉配置
      React.useEffect(() => {
        let alive = true
        void loadStyle().then((text) => { if (alive) injectStyle(text) })
        get(CONFIG_PATH).then((r) => {
          if (!alive) return
          if (!r || !r.values) {
            setLoadError('读不到配置——跳板插件可能没加载成功，检查 DSH 日志里的 cat-linker 行')
            return
          }
          setState(r)
          setDraft({ ...r.values })
          void runProbe(r.values.catBaseUrl)
        })
        return () => { alive = false }
      }, [])

      /** 改一个字段。 */
      const edit = (key, value) => {
        setDraft((old) => (old ? { ...old, [key]: value } : old))
        setMsg('')
      }

      /** 保存  */
      const save = async () => {
        if (!draft) return
        setBusy(true)
        const r = await post(CONFIG_PATH, draft)
        setBusy(false)
        if (r && r.ok) {
          setState((old) => ({ ...old, values: r.values }))
          setDraft({ ...r.values })
          setMsg(`已保存 ${r.changed} 项，已写入跳板配置`)
          if (r.values.catBaseUrl !== state.values.catBaseUrl) {
            void runProbe(r.values.catBaseUrl)
          }
        } else {
          setMsg('保存失败——看 DSH 日志')
        }
      }

      /** 放弃改动。 */
      const reset = () => {
        if (state) setDraft({ ...state.values })
        setMsg('')
      }

      if (loadError) {
        return h('div', { className: 'ck-wrap' },
          h('div', { className: 'ck-title' }, '黑猫工坊'),
          h('div', { className: 'ck-err' }, loadError))
      }
      if (!state || !draft) {
        return h('div', { className: 'ck-wrap' },
          h('div', { className: 'ck-title' }, '黑猫工坊'),
          h('div', { className: 'ck-desc' }, '读取中…'))
      }

      const dirty = JSON.stringify(state.values) !== JSON.stringify(draft)

      /** 渲染一个字段的控件。 */
      const control = (f) => {
        const v = draft[f.key]
        if (f.type === 'bool') {
          return h('input', {
            type: 'checkbox',
            checked: v === true,
            onChange: (e) => edit(f.key, e.target.checked),
          })
        }
        if (f.type === 'number') {
          return h('input', {
            type: 'number',
            className: 'ck-input',
            value: v == null ? '' : String(v),
            min: f.min,
            max: f.max,
            onChange: (e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) edit(f.key, n)
            },
          })
        }
        return h('input', {
          type: 'text',
          className: 'ck-input',
          value: v == null ? '' : String(v),
          onChange: (e) => edit(f.key, e.target.value),
        })
      }

      // 按 group 分卡片
      const cards = []
      let current = null
      for (const f of FIELDS) {
        if (f.group) {
          current = { group: f.group, fields: [] }
          cards.push(current)
        }
        if (current) current.fields.push(f)
      }

      return h('div', { className: 'ck-wrap' },
        h('div', { className: 'ck-title' }, '黑猫工坊'),
        h('div', { className: 'ck-desc' },
          'DSH 与 cat 服务器之间的接线。改完立即生效，下一轮心跳 / 拉取就会用新值。'),

        probeBar(probe),

        ...cards.map((c) => h('div', { key: c.group, className: 'ck-card' },
          h('div', { className: 'ck-group-title' }, c.group),
          ...c.fields.map((f) => h('div', { key: f.key, className: 'ck-row' },
            h('div', { className: 'ck-lab' }, f.label),
            h('div', { className: 'ck-ctl' },
              control(f),
              f.hint ? h('div', { className: 'ck-hint' }, f.hint) : null))))),

        msg
          ? h('div', { className: 'ck-msg ' + (msg.includes('已保存') ? 'ck-ok' : 'ck-err') }, msg)
          : null,

        h('div', { className: 'ck-bar' + (dirty ? ' ck-bar-dirty' : '') },
          dirty
            ? h('span', { className: 'ck-dirty' }, '有改动还没保存')
            : h('span', { className: 'ck-ok' }, '设置已同步'),
          h('button', {
            type: 'button', className: 'ck-btn-primary',
            onClick: save, disabled: busy || !dirty,
          }, busy ? '保存中…' : '保存'),
          h('button', {
            type: 'button', className: 'ck-btn',
            onClick: reset, disabled: busy || !dirty,
          }, '放弃改动'),
          h('button', {
            type: 'button', className: 'ck-btn', disabled: busy,
            onClick: () => {
              setBusy(true)
              get(CONFIG_PATH).then((r) => {
                setBusy(false)
                if (r && r.values) {
                  setState(r)
                  setDraft({ ...r.values })
                  setMsg('已重新读取')
                  void runProbe(r.values.catBaseUrl)
                }
              })
            },
          }, '重新读取')))
    }

    /** 连接探测结果条。 */
    function probeBar(probe) {
      if (!probe) {
        return h('div', { className: 'ck-probe ck-probe-neutral' }, '正在检查中转站连接…')
      }
      return h('div', {
        className: 'ck-probe ' + (probe.ok ? 'ck-probe-ok' : 'ck-probe-bad'),
      }, (probe.ok ? '✓ ' : '✗ ') + probe.detail)
    }

    // ── 入口 ────────────────────────────────────────────────

    /** 只依赖 slots —— 配置走自己的 HTTP，不碰 configForms。 */
    const inject = ['slots']

    function apply(ctx) {
      // 尽早点一次，样式尽早到 <head>，避免首屏闪一下无样式
      void loadStyle().then(injectStyle)

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'wdd-cat-linker',
          order: 54,
          label: () => '黑猫工坊',
        },
        LinkerSection,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
