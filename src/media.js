/**
 * 消息与图片的纯函数工具（无副作用、好单测）。
 *
 * 只做「取出来 / 解析路径 / 读字节」，不做「下载、落盘、发给谁」——
 * 那些属于 Java 中转站的职责（它才是业务主体）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 从 assistant 消息里抽纯文本：只拼 `type: 'text'` 的块。
 * 思考过程（reasoning）和图片都不算「说的话」。
 */
export function extractText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 挑出图片附件块。
 * 只认带 `attachment` 的 image 块 —— 那是 DSH 真正存下来的图，才有本地文件可用。
 */
export function extractAttachmentImages(message, limit = 9) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content
    .filter((block) => block && block.type === 'image' && block.attachment)
    .slice(0, limit)
}

/**
 * 从正文里抠 markdown 图片 `![名字](路径)`。
 *
 * 模型发贴纸就是这么发的；不抠掉的话 QQ 那边会看到一坨 markdown。
 *
 * @returns {{text: string, images: Array<{kind:'url'|'path', value:string}>}}
 */
export function extractInlineImages(text) {
  const images = []
  const clean = String(text || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (_whole, raw) => {
      const value = String(raw || '').trim()
      if (!value) return ''
      const kind = /^https?:\/\//i.test(value) ? 'url' : 'path'
      if (!images.some((item) => item.value === value)) images.push({ kind, value })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: clean, images }
}

/** 判断是不是绝对路径（跨平台）。 */
export function isAbsolutePath(path) {
  const p = String(path || '')
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/**
 * 把相对路径解析成存在的绝对路径。
 *
 * @param {string} relativePath
 * @param {string[]} roots 依次尝试的根目录
 * @returns {string} 找到返回绝对路径，否则空串
 */
export function resolveLocalPath(relativePath, roots) {
  const raw = String(relativePath || '').trim().replace(/^["']+|["']+$/g, '')
  if (!raw) return ''
  if (isAbsolutePath(raw)) {
    return existsSync(raw) ? raw : ''
  }
  for (const root of roots || []) {
    if (!root) continue
    try {
      const candidate = join(String(root), raw)
      if (existsSync(candidate)) return candidate
    } catch {
      // 非法路径继续试下一个根
    }
  }
  return ''
}

/**
 * 读文件成 base64。读不到返回空串。
 * （DSH 的附件服务只吃 base64，所以这一步留在跳板内部。）
 */
export function readAsBase64(path) {
  try {
    if (!path) return ''
    return readFileSync(path).toString('base64')
  } catch {
    return ''
  }
}

/** mime → 扩展名。 */
export function extensionOfMime(mime) {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'jpg'
  }
}

/** 日志摘要：压掉换行、超长截断。 */
export function summarize(text, max = 40) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}
