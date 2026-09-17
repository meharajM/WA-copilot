const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')
const { AgentdServer } = require('../../agentd/server.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('agentd chat sessions require auth, persist across restart, and isolate messages', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-chat-')
  const secret = 'c'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  assert.equal((await request(origin, 'GET', '/api/v1/sessions')).status, 401)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'one' }, {})).status, 401)
  const bearer = { authorization: `Bearer ${secret}` }
  const created = await request(origin, 'POST', '/api/v1/sessions', {
    id: 'one',
    title: 'First chat',
    status: 'resolved',
    channel: 'email',
    contactId: 'alice@example.com',
    threadId: 'thread-1',
  }, bearer)
  assert.equal(created.status, 201)
  assert.equal(created.body.session.id, 'one')
  assert.deepEqual({
    status: created.body.session.status,
    channel: created.body.session.channel,
    contactId: created.body.session.contactId,
    threadId: created.body.session.threadId,
  }, { status: 'resolved', channel: 'email', contactId: 'alice@example.com', threadId: 'thread-1' })
  const updated = await request(origin, 'PATCH', '/api/v1/sessions/one', {
    workspacePath: 'browser://workspace/Support',
    status: 'active',
    channel: 'whatsapp',
    contactId: '123@s.whatsapp.net',
    threadId: 'thread-2',
  }, bearer)
  assert.equal(updated.status, 200)
  assert.deepEqual({
    status: updated.body.session.status,
    channel: updated.body.session.channel,
    contactId: updated.body.session.contactId,
    threadId: updated.body.session.threadId,
    workspacePath: updated.body.session.workspacePath,
  }, { status: 'active', channel: 'whatsapp', contactId: '123@s.whatsapp.net', threadId: 'thread-2', workspacePath: 'browser://workspace/Support' })
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/one/messages', { id: 'm1', role: 'user', content: 'hello' }, bearer)).status, 201)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/two/messages', { id: 'm1', role: 'user', content: 'wrong session' }, bearer)).status, 404)
  assert.equal((await request(origin, 'GET', '/api/v1/sessions/one', undefined, bearer)).body.messages[0].content, 'hello')
  await server.stop()

  const recovered = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const restarted = await recovered.start()
  const sessions = await request(restarted.origin, 'GET', '/api/v1/sessions', undefined, bearer)
  assert.deepEqual(sessions.body.sessions.map(session => session.id), ['one'])
  const session = await request(restarted.origin, 'GET', '/api/v1/sessions/one', undefined, bearer)
  assert.deepEqual(session.body.messages.map(message => message.id), ['m1'])
  assert.deepEqual({
    status: session.body.session.status,
    channel: session.body.session.channel,
    contactId: session.body.session.contactId,
    threadId: session.body.session.threadId,
    workspacePath: session.body.session.workspacePath,
  }, { status: 'active', channel: 'whatsapp', contactId: '123@s.whatsapp.net', threadId: 'thread-2', workspacePath: 'browser://workspace/Support' })
  await recovered.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd chat messages are idempotent and reject conflicting retries', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-chat-idempotent-')
  const secret = 'd'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 's1' }, bearer)).status, 201)
  const message = { id: 'same', role: 'assistant', content: 'safe response' }
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => request(origin, 'POST', '/api/v1/sessions/s1/messages', message, bearer)))
  assert.equal(concurrent.filter(result => result.status === 201).length, 1)
  assert.equal(concurrent.filter(result => result.status === 200).length, 11)
  assert.equal(concurrent.every(result => result.body.message.content === 'safe response'), true)
  const duplicate = await request(origin, 'POST', '/api/v1/sessions/s1/messages', message, bearer)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.duplicate, true)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/messages', { ...message, content: 'changed' }, bearer)).status, 409)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/messages', message, {})).status, 401)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd upgrades legacy chat session tables without losing existing sessions', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-chat-legacy-')
  const legacy = new Database(path.join(dataDir, 'agentd.db'))
  legacy.exec(`CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ); INSERT INTO chat_sessions VALUES ('legacy', 'Legacy chat', NULL, 10, 20);`)
  legacy.close()

  const secret = 'l'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const existing = await request(origin, 'GET', '/api/v1/sessions/legacy', undefined, bearer)
  assert.equal(existing.status, 200)
  assert.deepEqual(existing.body.session, {
    id: 'legacy',
    title: 'Legacy chat',
    createdAt: 10,
    updatedAt: 20,
    status: 'active',
  })
  const created = await request(origin, 'POST', '/api/v1/sessions', { id: 'new', title: 'New', channel: 'whatsapp', contactId: '123@s.whatsapp.net' }, bearer)
  assert.equal(created.status, 201)
  assert.equal(created.body.session.contactId, '123@s.whatsapp.net')
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd chat session deletion is authenticated, idempotent, cascades messages, and survives restart', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-chat-delete-')
  const secret = 'f'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'gone', title: 'Delete me' }, bearer)).status, 201)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/gone/messages', { id: 'm1', role: 'user', content: 'remove me' }, bearer)).status, 201)
  assert.equal((await request(origin, 'DELETE', '/api/v1/sessions/gone', undefined, {})).status, 401)
  const removed = await request(origin, 'DELETE', '/api/v1/sessions/gone', undefined, bearer)
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.body, { success: true, deleted: true })
  assert.equal((await request(origin, 'GET', '/api/v1/sessions/gone', undefined, bearer)).status, 404)
  assert.deepEqual((await request(origin, 'DELETE', '/api/v1/sessions/gone', undefined, bearer)).body, { success: true, deleted: false })
  await server.stop()

  const recovered = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const restarted = await recovered.start()
  assert.deepEqual((await request(restarted.origin, 'GET', '/api/v1/sessions', undefined, bearer)).body.sessions, [])
  await recovered.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd chat routes enforce bounded identifiers, content, fields, and CSRF', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-chat-bounds-')
  const secret = 'e'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'bad/id' }, bearer)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'valid', unknown: 'secret' }, bearer)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'bad-channel', channel: 'mcp' }, bearer)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'bad-contact', contactId: 'x'.repeat(513) }, bearer)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'valid' }, bearer)).status, 201)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/valid/messages', { id: 'm', role: 'user', content: 'x'.repeat(32 * 1024 + 1) }, bearer)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/valid/messages', { id: 'm', role: 'user', content: 'x', secret: 'must-not-persist' }, bearer)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/valid/messages', { id: 'm', role: 'user', content: 'x' }, { origin })).status, 401)
  assert.equal((await request(origin, 'GET', '/api/v1/sessions/valid/messages', undefined, bearer)).status, 404)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
