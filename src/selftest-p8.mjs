/**
 * P8 跳板逻辑自测 —— 不启动 DSH，只用假对象驱动。
 *
 * 覆盖三件在存档制度里最容易搞错的事：
 *   ① ArchiveSource 按聊天反查存档（可能返回多个，允许抢话）；
 *   ② TurnOrigin 记的来源带 archiveId 与 channel；
 *   ③ Outbound 在没有来源时不发（手动说话不外发）。
 *
 * 跑法：node src/selftest-p8.mjs
 */

import assert from 'node:assert/strict'

import { ArchiveSource } from './archives.js'
import { TurnOrigin } from './origin.js'

// ─────────────────────────── 假的 bridge ───────────────────────────

function fakeBridge(payload) {
  return {
    async get(path) {
      if (path.includes('/archives')) return payload
      return null
    },
    async post() { return {} },
  }
}

const noopLog = Object.assign(() => {}, { failOnce: () => {} })
const silentLog = Object.assign(() => {}, { failOnce: () => {} })

// ─────────────────────────── ① ArchiveSource ───────────────────────────

async function testArchiveSource() {
  const payload = {
    archives: [
      {
        id: '111', name: '黑猫', enabled: true,
        session: { sessionId: 'session-a', status: 'BOUND' },
        links: [{ kind: 'qq', enabled: true, account: '10000', baseUrl: '', token: '' }],
        relations: [
          { chatType: 'group', chatId: '20001', enabled: true },
          { chatType: 'private', chatId: '10002', enabled: true },
        ],
      },
      {
        id: '222', name: '白猫', enabled: true,
        session: { sessionId: 'session-b', status: 'BOUND' },
        links: [{ kind: 'qq', enabled: true, account: '10001', baseUrl: '', token: '' }],
        relations: [
          { chatType: 'group', chatId: '20001', enabled: true },
        ],
      },
      {
        id: '333', name: '灰猫', enabled: true,
        session: { sessionId: 'session-c', status: 'BOUND' },
        links: [{ kind: 'qq', enabled: true, account: '10003', baseUrl: '', token: '' }],
        relations: [
          { chatType: 'private', chatId: '10099', enabled: true },
        ],
      },
      {
        id: '444', name: '停用的', enabled: false,
        session: { sessionId: 'session-d', status: 'BOUND' },
        links: [{ kind: 'qq', enabled: true, account: '10004', baseUrl: '', token: '' }],
        relations: [{ chatType: 'group', chatId: '99999', enabled: true }],
      },
    ],
  }

  const source = new ArchiveSource({ bridge: fakeBridge(payload), log: silentLog })
  const ok = await source.refresh()
  assert.equal(ok, true, 'refresh 应当成功')
  assert.equal(source.archives.length, 4, '应当拉到 4 个存档')

  // 群 20001 被两个存档认领 → 抢话
  const groupHits = source.forChat('group:20001')
  assert.equal(groupHits.length, 2, '群 20001 应当被两个存档认领（允许抢话）')
  assert.deepEqual(groupHits.map((a) => a.name).sort(), ['白猫', '黑猫'].sort())

  // 私聊只有黑猫
  const privateHits = source.forChat('private:10002')
  assert.equal(privateHits.length, 1)
  assert.equal(privateHits[0].name, '黑猫')

  // 停用的存档不参与投递
  assert.equal(source.forChat('group:99999').length, 0, '停用的存档不该收消息')

  // 没人认领的聊天
  assert.equal(source.forChat('group:12345').length, 0)

  // 按 id 取
  assert.equal(source.get('222').name, '白猫')
  assert.equal(source.get('999'), undefined)

  console.log('  ✓ ArchiveSource：抢话 / 停用 / 无人认领 / 按 id 查 全部正确')
}

// ─────────────────────────── ② 会话丢失不发 ───────────────────────────

async function testLostSessionExcluded() {
  const payload = {
    archives: [{
      id: '555', name: '丢会话的', enabled: true,
      session: { sessionId: 'session-x', status: 'LOST' },
      links: [{ kind: 'qq', enabled: true, account: '10005', baseUrl: '', token: '' }],
      relations: [{ chatType: 'group', chatId: '30001', enabled: true }],
    }],
  }
  const source = new ArchiveSource({ bridge: fakeBridge(payload), log: silentLog })
  await source.refresh()

  assert.equal(source.forChat('group:30001').length, 0,
    '会话 LOST 的存档不该被投递（投了也进不去）')
  console.log('  ✓ 会话丢失的存档被排除在投递之外')
}

// ─────────────────────────── ③ TurnOrigin ───────────────────────────

function testTurnOrigin() {
  const origin = new TurnOrigin()

  // 记一个带完整信息的来源
  origin.remember('session-a', { archiveId: '111', chatKey: 'group:20001', channel: 'QQ' })
  const got = origin.of('session-a')
  assert.equal(got.archiveId, '111')
  assert.equal(got.chatKey, 'group:20001')
  assert.equal(got.channel, 'QQ')

  // 消费后清空
  origin.consume('session-a')
  assert.equal(origin.of('session-a'), null, '消费后应当取不到——手动说话不外发靠这个')

  // 兼容旧的字符串写法
  origin.remember('session-b', 'private:10002')
  const legacy = origin.of('session-b')
  assert.equal(legacy.chatKey, 'private:10002')
  assert.equal(legacy.channel, 'QQ', '旧写法默认当 QQ')
  assert.equal(legacy.archiveId, '')

  // 空 chatKey 不记
  origin.remember('session-c', { archiveId: '111', chatKey: '' })
  assert.equal(origin.of('session-c'), null)

  console.log('  ✓ TurnOrigin：完整来源 / 消费清空 / 兼容旧写法 全部正确')
}

// ─────────────────────────── ④ Outbound 无来源不发 ───────────────────────────

async function testOutboundSkipsWithoutOrigin() {
  const { Outbound } = await import('./outbound.js')

  const posted = []
  const bridge = {
    async post(path, body) { posted.push({ path, body }); return {} },
    async get() { return { archives: [] } },
  }

  const archivePayload = {
    archives: [{
      id: '111', name: '黑猫', enabled: true,
      session: { sessionId: 'session-a', status: 'BOUND' },
      links: [{ kind: 'qq', enabled: true, account: '10000', baseUrl: '', token: '' }],
      relations: [{ chatType: 'group', chatId: '20001', enabled: true }],
    }],
  }
  const source = new ArchiveSource({ bridge: fakeBridge(archivePayload), log: silentLog })
  await source.refresh()

  const logs = []
  const log = Object.assign((t) => logs.push(t), { failOnce: () => {} })

  const outbound = new Outbound({
    getConfig: () => ({ enabled: true, relayOutbound: true }),
    resolver: { rootsForSession: () => [] },
    bridge,
    archives: source,
    origin: new TurnOrigin(),
    log,
    attachmentsService: () => null,
    resolveOriginal: () => '',
  })

  // 场景 A：没有来源（手动说话）→ 不该发
  outbound.handleSessionEvent({ id: 'session-a' }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '我手动说的' }] } },
  })
  await outbound.finishTurn('session-a', { turn: 1, reason: { kind: 'completed' } }, {})
  assert.equal(posted.length, 0, '无来源应当是「一个字都不发」')
  assert.ok(logs.some((l) => l.includes('没有外部来源')), '应当记一条说明')

  // 场景 B：有来源 → 应当发，且带上 archiveId 与 origin
  outbound.origin.remember('session-a', { archiveId: '111', chatKey: 'group:20001', channel: 'QQ' })
  outbound.handleSessionEvent({ id: 'session-a' }, {
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'text', text: '正常回复' }] } },
  })
  await outbound.finishTurn('session-a', { turn: 2, reason: { kind: 'completed' } }, {})

  assert.equal(posted.length, 1, '有来源应当发一条')
  const body = posted[0].body
  assert.equal(body.archiveId, '111')
  assert.equal(body.origin, 'QQ')
  assert.deepEqual(body.chatKeys, ['group:20001'])
  assert.equal(body.text, '正常回复')

  // 场景 C：存档不存在 → 不发
  outbound.origin.remember('session-a', { archiveId: '999', chatKey: 'group:20001', channel: 'QQ' })
  outbound.handleSessionEvent({ id: 'session-a' }, {
    type: 'assistant/message',
    data: { turn: 3, message: { content: [{ type: 'text', text: '存档没了' }] } },
  })
  await outbound.finishTurn('session-a', { turn: 3, reason: { kind: 'completed' } }, {})
  assert.equal(posted.length, 1, '存档不存在时不该再发')

  console.log('  ✓ Outbound：无来源不发 / 有来源带 archiveId+origin / 存档不在不发')
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  console.log('P8 跳板自测')
  console.log('')
  await testArchiveSource()
  await testLostSessionExcluded()
  testTurnOrigin()
  await testOutboundSkipsWithoutOrigin()
  console.log('')
  console.log('全部通过 ✓')
}

main().catch((error) => {
  console.error('')
  console.error('✗ 失败：', error.message)
  process.exit(1)
})
