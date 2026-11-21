/** 消息与图片的纯函数工具 */

/** Content → 纯文本。第一版只处理 text 段。 */
export function plainText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content.value === 'string') return content.value
  if (Array.isArray(content.parts)) {
    return content.parts.map(plainText).filter(Boolean).join(' ')
  }
  return ''
}

/** 压成一行,用于日志 */
export function summarize(text, max = 40) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}
