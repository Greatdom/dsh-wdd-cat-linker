
window.__ModuleLoader__.load({
  // 模块身份 = 本包的包名。必须与 package.json 的 name 完全一致。
  id: 'dsh-wdd-cat-linker',

  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 平台模块表里的模块。React 只用默认导出，别写成具名导入。
    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const jsx = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs

    // ——— 组件 ———
    //
    // 插槽组件拿到的 props（这里能用到的一部分）：
    //   t          翻译函数（本插件注册的字典里取值）
    //   renderSlot 渲子插槽的函数
    //   close      关掉设置弹窗（SettingsSectionOwnerProps 唯一提供的动作）
    // 组件返回的必须是 React 元素。
    function TestSection({ t }) {
      return jsxs('div', {
        // 与官方设置页保持同样的容器：最大宽度 + 纵向排列
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxWidth: '760px',
        },
        // data-slot 让调试时一眼看出这块是哪个插槽渲出来的
        'data-slot': 'settings.section',
        'data-slot-id': 'test',
        children: [
          jsx('h2', {
            style: { margin: 0, fontSize: '18px', fontWeight: 600 },
            children: t('title'),
          }),
          jsx('p', {
            style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
            // ★ 需求里要的那一行 hello
            children: t('hello'),
          }),
        ],
      })
    }

    // ——— 字典 ———
    //
    // 官方客户端插件一律把文案放在 locale 字典里，再用注入的 t 取值，
    // 这样切换中英文时这里会跟着变。键名是本插件私有的命名空间。
    const NS = 'settings.testCard'
    const zh = {
      nav: 'Test',
      title: 'Test',
      hello: 'hello',
    }
    const en = {
      nav: 'Test',
      title: 'Test',
      hello: 'hello',
    }

    // ——— 依赖声明 ———
    //
    // cordis 的语义：这里列出的服务全部就绪之前，apply 不会被调用。
    //   slots  插槽注册表（必须）
    //   locale 翻译服务（注册字典 + 绑定 t）
    const inject = ['slots', 'locale']

    // ——— 插件入口 ———
    function apply(ctx) {
      // 1) 注册字典。用 ctx.effect 包一层，插件卸载时自动反注册。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'test-card: dictionaries')

      // 2) 绑定翻译函数
      const t = ctx.locale.bind(NS)

      // 3) 把自己插进 settings.section。
      //
      //    ctx.slots.inject(key, cb) 的意思是
      //    「等 key 这个插槽被别人声明出来之后，再执行 cb」。
      //    settings.section 由外壳 dsh-client-ui-settings-general 声明，
      //    所以这里不用关心加载顺序。
      //
      //    register 的 options：
      //      name   固定写插槽名
      //      id     list 插槽必填 —— 导航栏里用哪一格
      //      order  导航栏里的排序位置（越小越靠上）
      //      label  导航栏那一格显示的文字（注意：这里是函数，不是字符串）
      //      locale 这个条目属于哪个字典命名空间
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'test',
            order: 5,
            label: () => t('nav'),
            locale: NS,
          },
          TestSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
