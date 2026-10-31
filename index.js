import Schema from '@deepseek-ai/schemastery'

// — 插件的身份 —
export const name = 'dsh-wdd-cat-linker'

// 声明依赖：等 ctx.tools（工具注册表）就绪后，框架才会加载本插件
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments']


// — 用户可配置项 —
export const Config = Schema.object({
  
})


// — dsh监听器 —
export function apply(ctx, config) {

    
}