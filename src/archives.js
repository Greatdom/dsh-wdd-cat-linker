/**
 * 存档源：从 Java 拉「有哪些存档、各自要服务哪些聊天」。
 *
 * ---- 为什么取代 bindings.js ----
 *
 * 绑定制度是「一个 QQ 聊天 → 一处落点」的扁平表，隐含「全系统只有一个机器人」。
 * 存档制度是「一个存档 = 一个模拟人」，它有自己的一条会话、若干外部连接、一份人际关系白名单。
 * 跳板要做的事从「查表找落点」变成「查存档、按聊天分组」。
 *
 * ---- 三个关键接口 ----
 *
 *  - `refresh()`        从 Java 拉全量存档（心跳时调）
 *  - `forChat(chatKey)` 这条消息该投给**哪些**存档 → **数组**（允许抢话）
 *  - `get(archiveId)`   某个存档本身
 *
 * ---- 为什么 forChat 返回数组 ----
 *
 * 设计文档 Q2 / Q3 定的是「允许抢话」：同一个群可以被多个存档同时认领，
 * 都投、都回。所以这里是数组而不是单个。
 *
 * ---- 存档由 Java 托管 ----
 *
 * 跳板不存存档配置，只在内存里缓存 Java 给的那一份。改存档去 `/archives` 页面。
 */

import { API } from './api.js'

export class ArchiveSource {
  /**
   * @param {object} deps
   * @param {import('./bridge.js').Bridge} deps.bridge
   * @param {(text: string, meta?: object) => void} deps.log
   */
  constructor({ bridge, log }) {
    this.bridge = bridge
    this.log = log

    /** 上次拉到的存档列表（已规整）。 */
    this.archives = []
    /** archiveId -> archive，O(1) 查。 */
    this.byId = new Map()
    /** chatKey -> archive[]，投递时按聊天反查。 */
    this.byChat = new Map()

    /** 上次那份清单的指纹，用来「内容没变就不重复打日志」。 */
    this.fingerprint = ''
  }

  /**
   * 从 Java 拉一次存档。
   *
   * <p>拉不到就沿用上一份——网络抖一下不该让整条链路停摆。
   *
   * @returns {Promise<boolean>} 是否成功拉取
   */
  async refresh() {
    let remote = null
    try {
      remote = await this.bridge.get(API.archives)
    } catch (error) {
      this.log.failOnce('拉取存档失败（沿用上一份）：' + String((error && error.message) || error))
      return false
    }
    if (!remote || !Array.isArray(remote.archives)) {
      return false
    }

    const next = remote.archives.map(normalizeArchive).filter(Boolean)
    const fingerprint = JSON.stringify(next)
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.#reindex(next)
      this.#logList()
    } else {
      // 内容没变也要重建索引：会话状态可能变了（BOUND ↔ LOST）
      this.#reindex(next)
    }
    return true
  }

  /** 重建三个索引。 */
  #reindex(list) {
    this.archives = list
    this.byId = new Map()
    this.byChat = new Map()

    for (const archive of list) {
      this.byId.set(archive.id, archive)
      for (const relation of archive.relations) {
        const key = `${relation.chatType}:${relation.chatId}`
        const bucket = this.byChat.get(key) || []
        bucket.push(archive)
        this.byChat.set(key, bucket)
      }
    }
  }

  #logList() {
    if (!this.archives.length) {
      this.log('还没有存档。去 Java 的 /archives 页面建一个（一个存档 = 一个模拟人）')
      return
    }
    this.log(`存档来源：Java 托管（${this.archives.length} 个）`)
    for (const archive of this.archives) {
      const chats = archive.relations.length
      const links = archive.links.length
      this.log(`  「${archive.name}」会话 ${short(archive.sessionId)}｜连接 ${links} 个`
        + `｜人际 ${chats} 条${archive.enabled ? '' : '（已停用）'}`)
    }
  }

  /** 某个存档（不存在返回 undefined）。 */
  get(archiveId) {
    return this.byId.get(String(archiveId))
  }

  /** 全部启用的存档。 */
  enabled() {
    return this.archives.filter((a) => a.enabled)
  }

  /**
   * 这条消息该投给哪些存档。
   *
   * @param {string} chatKey 形如 {@code group:20001}
   * @returns {object[]} 可以是空数组（没人认领），也可以多于一个（抢话）
   */
  forChat(chatKey) {
    const bucket = this.byChat.get(String(chatKey))
    if (!bucket) return []
    // 只投给启用且会话没丢的
    return bucket.filter((a) => a.enabled && a.sessionStatus !== 'LOST' && a.sessionId)
  }

  /** 全部存档涉及的 chatKey 集合。 */
  allChats() {
    return [...this.byChat.keys()]
  }
}

/**
 * 规整一个存档。
 *
 * <p>Java 回来的是宽松 JSON，这里统一成跳板好用的形状：
 * 全部字段有确定类型，调用方不用到处判空。
 */
function normalizeArchive(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null

  const session = raw.session || {}
  const links = Array.isArray(raw.links) ? raw.links : []
  const relations = Array.isArray(raw.relations) ? raw.relations : []

  return {
    id,
    name: String(raw.name || '').trim() || '未命名存档',
    enabled: raw.enabled !== false,
    sessionId: String(session.sessionId || '').trim(),
    sessionStatus: String(session.status || 'LOST').toUpperCase(),
    links: links
      .filter((l) => l && String(l.kind || '').toLowerCase() === 'qq')
      .map((l) => ({
        kind: 'qq',
        enabled: l.enabled !== false,
        account: String(l.account || '').trim(),
        baseUrl: String(l.baseUrl || '').trim(),
        token: String(l.token || ''),
      })),
    relations: relations
      .map((r) => ({
        chatType: String(r.chatType || '').toLowerCase(),
        chatId: String(r.chatId || '').trim(),
        enabled: r.enabled !== false,
      }))
      .filter((r) => (r.chatType === 'group' || r.chatType === 'private') && r.chatId && r.enabled),
  }
}

/** 只留尾段，日志里好认。 */
function short(id) {
  const s = String(id || '')
  if (!s) return '（未绑定）'
  return s.length > 10 ? '…' + s.slice(-8) : s
}
