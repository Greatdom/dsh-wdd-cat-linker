
/**
 * 跳板的浏览器端：在 DSH 设置左侧栏加一页「通到 QQ 配置」。
 *
 * ---- 为什么不使用 DSH 的配置表单组件 ----
 *
 * DSH 的 `ctx.configForms` 只认 **include 条目**（`entry.parent.tree.ctx.fiber.entry?.id === 'include'`）。
 * 通过 `profile.bundles` 装进来的插件拿不到配置表单，实测 `rawStatus: unavailable`。
 *
 * 所以这里走自己的一条路：
 *
 *   Java 的 /api/v1/linker/config   ←→   本文件里的原生表单
 *
 * 好处不止「能跑」：
 *   · 改配置**不需要重启 DSH**，也不用重载插件（DSH 那套要整插件重载，会丢内存状态）；
 *   · 跳板下次心跳自然读到新值，不需要任何通知机制。
 *
 * ---- 加载格式 ----
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => ... })
 *
 * React 由宿主注入（package.json 的 dsh.client.external 里声明了 react）。
 */

window.__ModuleLoader__.load({
  // 模块身份 = 包名，必须与 package.json 的 name 一致。
  id: 'dsh-wdd-cat-linker',

  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /**
     * 配置读写走**宿主同源路由**（`/wdd-cat-linker/config`）。
     *
     * 为什么是相对路径：这条路由由跳板自己注册在 DSH 宿主上，
     * 页面和它同源，不需要跨域、也不会打到 Java 那边。
     *
     * 之前配置存在 Java 时用的是绝对地址 + CORS，那条路已经废掉了 ——
     * 「Java 没起来就读不到配置」正是要解决的问题。
     */
    const CONFIG_PATH = '/wdd-cat-linker/config'

    // ── 取值 ────────────────────────────────────────────────

    /** 读；失败返回 null，不抛（页面不该因为一次网络抖动白屏）。 */
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
     *
     * 直接打目标地址的 `/api/v1/health` —— 这里是**跨域**请求，
     * 所以 Java 侧的 CORS 配置（WebCorsConfig）仍然需要保留。
     *
     * @param {string} baseUrl 用户当前填的地址
     * @param {string} token   有就带上
     * @returns {Promise<{ok: boolean, detail: string}>}
     */
    async function probeServer(baseUrl, token) {
      const base = String(baseUrl || '').trim().replace(/\/+$/, '')
      if (!base) return { ok: false, detail: '还没填地址' }

      let url
      try {
        url = new URL('/api/v1/health', base).toString()
      } catch {
        return { ok: false, detail: '地址格式不对，示例: http://127.0.0.1:8080' }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const headers = { accept: 'application/json' }
        if (token) headers.authorization = `Bearer ${token}`
        const res = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
        if (!res.ok) {
          return { ok: false, detail: `服务器有响应但状态码是 ${res.status}` }
        }
        const body = await res.json().catch(() => null)
        const onebot = body && body.onebot
        if (onebot && onebot.ok === false) {
          return { ok: true, detail: `中转站在线，但 QQ 没连上（${onebot.error || '原因不明'}）` }
        }
        const qq = onebot && onebot.nickname ? `，QQ：${onebot.nickname}` : ''
        return { ok: true, detail: `中转站在线${qq}` }
      } catch (error) {
        const msg = String((error && error.message) || error)
        if (controller.signal.aborted) {
          return { ok: false, detail: '连接超时（4 秒没响应）' }
        }
        return { ok: false, detail: `连不上：${msg}` }
      } finally {
        clearTimeout(timer)
      }
    }

    // ── 字段定义（决定表单长什么样）────────────────────────

    const FIELDS = [
      { group: '基本', key: 'catBaseUrl', label: '中转站地址', hint: '本地 Java 服务，如 http://127.0.0.1:8080', type: 'text' },
      { key: 'catToken', label: '中转站令牌', hint: 'Java 开了鉴权才填，留空 = 不鉴权', type: 'password' },
      { key: 'workspacePick', label: '工作区挑会话方式', hint: 'recent = 最近有活动，first = 排最前', type: 'select', options: [['recent', 'recent'], ['first', 'first']] },

      { group: '收发开关', key: 'enabled', label: '总开关', hint: '关掉 = 完全不收发', type: 'bool' },
      { key: 'relayOutbound', label: 'DSH → QQ', hint: '模型说完一轮，把回复发到 QQ', type: 'bool' },
      { key: 'relayInbound', label: 'QQ → DSH', hint: 'QQ 里的消息投进 DSH 会话', type: 'bool' },

      { group: '节奏', key: 'presenceIntervalMs', label: '心跳间隔（毫秒）', hint: '1000~60000', type: 'number', min: 1000, max: 60000 },
      { key: 'outboxPollMs', label: '拉队列间隔（毫秒）', hint: '300~30000', type: 'number', min: 300, max: 30000 },
      { key: 'requestTimeoutMs', label: '请求超时（毫秒）', hint: '1000~60000', type: 'number', min: 1000, max: 60000 },
    ]

    // ── 样式 ────────────────────────────────────────────────

    const S = {
      wrap: { padding: '16px 18px 24px', fontSize: 13, lineHeight: 1.7, maxWidth: 760 },
      title: { fontSize: 18, fontWeight: 600, margin: '0 0 4px' },
      desc: { margin: '0 0 16px', fontSize: 13, opacity: 0.65 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 12,
      },
      groupTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 10px', opacity: 0.85 },
      row: { display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap' },
      lab: { flex: '0 0 170px', paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 200 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      bar: {
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '10px 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.96))',
        boxShadow: '0 -4px 14px rgba(0,0,0,.12)',
        marginTop: 12,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
        borderRadius: 6,
        padding: '5px 14px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      btnPrimary: {
        border: '1px solid var(--dsw-alias-state-business-primary, #4a7dff)',
        borderRadius: 6,
        padding: '5px 14px',
        background: 'var(--dsw-alias-state-business-primary, #4a7dff)',
        color: '#fff',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      ok: { color: 'var(--dsw-alias-state-business-primary, #4a7dff)', fontSize: 12 },
      dirty: { color: '#c0392b', fontSize: 12, fontWeight: 600 },
      err: { color: '#c0392b', fontSize: 12 },
      probeOk: {
        padding: '8px 12px',
        marginBottom: 12,
        borderRadius: 8,
        fontSize: 12.5,
        color: 'var(--dsw-alias-state-business-primary, #1a7f37)',
        background: 'rgba(26,127,55,.08)',
        border: '1px solid rgba(26,127,55,.25)',
      },
      probeBad: {
        padding: '8px 12px',
        marginBottom: 12,
        borderRadius: 8,
        fontSize: 12.5,
        color: '#c0392b',
        background: 'rgba(192,57,43,.08)',
        border: '1px solid rgba(192,57,43,.25)',
      },
      probeNeutral: {
        padding: '8px 12px',
        marginBottom: 12,
        borderRadius: 8,
        fontSize: 12.5,
        opacity: 0.7,
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
      },
      btnSmall: {
        border: '1px solid currentColor',
        borderRadius: 5,
        padding: '2px 10px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },
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
      const [probing, setProbing] = React.useState(false)

      /** 测一次中转站，把结果记进状态。 */
      const runProbe = async (baseUrl, token) => {
        setProbing(true)
        const result = await probeServer(baseUrl, token)
        setProbing(false)
        setProbe(result)
        return result
      }

      // 首次拉配置（走宿主同源路由，**不需要 Java 在线**）
      React.useEffect(() => {
        let alive = true
        get(CONFIG_PATH).then((r) => {
          if (!alive) return
          if (!r || !r.values) {
            setLoadError('读不到配置——跳板插件可能没加载成功，检查 DSH 日志里的 wdd-cat-linker 行')
            return
          }
          setState(r)
          setDraft({ ...r.values })
          // 进来先探一次，告诉用户当前地址通不通
          void runProbe(r.values.catBaseUrl, r.values.catToken)
        })
        return () => { alive = false }
      }, [])

      /** 改一个字段（只改草稿，不落盘）。 */
      const edit = (key, value) => {
        setDraft((old) => (old ? { ...old, [key]: value } : old))
        setMsg('')
      }

      /** 保存。**不要求 Java 在线** —— 配置存在跳板本地。 */
      const save = async () => {
        if (!draft) return
        setBusy(true)
        const r = await post(CONFIG_PATH, draft)
        setBusy(false)
        if (r && r.ok) {
          setState((old) => ({ ...old, values: r.values }))
          setDraft({ ...r.values })
          setMsg(`已保存 ${r.changed} 项 ✓ 已写入跳板配置，立即生效`)
          // 地址或令牌变了就顺手重测一次
          if (r.values.catBaseUrl !== state.values.catBaseUrl
            || r.values.catToken !== state.values.catToken) {
            void runProbe(r.values.catBaseUrl, r.values.catToken)
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

      // 首次加载中 / 失败
      if (loadError) {
        return h('div', { style: S.wrap }, h('div', { style: S.title }, '通到 QQ'), h('div', { style: S.err }, loadError))
      }
      if (!state || !draft) {
        return h('div', { style: S.wrap }, h('div', { style: S.title }, '通到 QQ'), h('div', { style: S.desc }, '读取中…'))
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
        if (f.type === 'select') {
          return h('select', {
            style: S.input,
            value: String(v ?? ''),
            onChange: (e) => edit(f.key, e.target.value),
          }, ...f.options.map(([val, text]) => h('option', { key: val, value: val }, text)))
        }
        if (f.type === 'number') {
          return h('input', {
            type: 'number',
            min: f.min,
            max: f.max,
            style: S.input,
            value: v == null ? '' : String(v),
            onChange: (e) => edit(f.key, e.target.value === '' ? '' : Number(e.target.value)),
          })
        }
        return h('input', {
          type: f.type === 'password' ? 'password' : 'text',
          style: S.input,
          value: v == null ? '' : String(v),
          onChange: (e) => edit(f.key, e.target.value),
        })
      }

      /** 按分组切块。 */
      const cards = []
      let current = null
      for (const f of FIELDS) {
        if (f.group) {
          if (current) cards.push(current)
          current = { group: f.group, fields: [f] }
        } else if (current) {
          current.fields.push(f)
        }
      }
      if (current) cards.push(current)

      /** 连接状态条：鼠标停一下能看详情。 */
      const statusBar = () => {
        if (probing) {
          return h('div', { style: S.probeNeutral }, '正在检查中转站连接…')
        }
        if (!probe) {
          return h('div', { style: S.probeNeutral }, '还没检查中转站连接')
        }
        const style = probe.ok ? S.probeOk : S.probeBad
        const icon = probe.ok ? '✓' : '✗'
        return h('div', { style: { ...style, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', null, `${icon} ${probe.detail}`),
          h('button', {
            type: 'button',
            style: S.btnSmall,
            disabled: probing,
            onClick: () => void runProbe(draft.catBaseUrl, draft.catToken),
          }, '测试连接'),
          probe.ok
            ? null
            : h('span', { style: S.hint },
              '连不上也能改配置——配置存在跳板本地，不依赖服务器。'),
        )
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.title }, '通到 QQ'),
        h('div', { style: S.desc },
          'QQ 与 DSH 会话之间的收发中转。业务节奏在 Java 中转站，这里只调接线。'
          + '配置保存在跳板的本地文件里，**不依赖中转站是否在线**；改完点保存立即生效。'),

        statusBar(),

        ...cards.map((c) => h('div', { key: c.group, style: S.card },
          h('div', { style: S.groupTitle }, c.group),
          ...c.fields.map((f) => h('div', { key: f.key, style: S.row },
            h('div', { style: S.lab }, f.label),
            h('div', { style: S.ctl },
              control(f),
              f.hint ? h('div', { style: S.hint }, f.hint) : null))))),

        msg ? h('div', { style: msg.includes('✓') ? S.ok : S.err, marginBottom: 8 }, msg) : null,

        h('div', { style: { ...S.bar, borderColor: dirty ? 'var(--dsw-alias-state-business-primary, #4a7dff)' : undefined } },
          dirty
            ? h('span', { style: S.dirty }, '⚠ 有改动还没保存')
            : h('span', { style: S.ok }, '设置已同步 ✓'),
          h('button', { type: 'button', style: S.btnPrimary, onClick: save, disabled: busy || !dirty }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.btn, onClick: reset, disabled: busy || !dirty }, '放弃改动'),
          h('button', {
            type: 'button', style: S.btn, disabled: busy,
            onClick: () => {
              setBusy(true)
              get(CONFIG_PATH).then((r) => {
                setBusy(false)
                if (r && r.values) {
                  setState(r)
                  setDraft({ ...r.values })
                  setMsg('已重新读取')
                  void runProbe(r.values.catBaseUrl, r.values.catToken)
                }
              })
            },
          }, '重新读取')),
      )
    }

    // ── 入口 ────────────────────────────────────────────────

    /** 只依赖 slots —— 配置走自己的 HTTP，不碰 configForms。 */
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'wdd-cat-linker',
          order: 54,
          label: () => '通到 QQ',
        },
        LinkerSection,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
