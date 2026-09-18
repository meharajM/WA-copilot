const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

const request = (origin, method, pathname, body, headers = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
    let text = ''
    res.on('data', chunk => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
  })
  req.on('error', reject)
  req.end(payload)
})

const delayedRequest = (origin, method, pathname, body, headers = {}) => {
  const payload = JSON.stringify(body)
  let resolveResponse
  let rejectResponse
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject })
  const req = http.request(`${origin}${pathname}`, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, res => {
    let text = ''
    res.on('data', chunk => { text += chunk })
    res.on('end', () => {
      try { resolveResponse({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }) } catch (error) { rejectResponse(error) }
    })
  })
  req.on('error', rejectResponse)
  return { req, response, send: () => req.end(payload) }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('Timed out waiting for migration admission')
}

function sourceFixture({ content = 'hello', metadata = true } = {}) {
  const root = makeTempDir('aica-electron-chat-history-')
  const db = new Database(path.join(root, 'chat_history.v2.db'))
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, channel TEXT, contact_id TEXT, status TEXT, workspacePath TEXT, topic TEXT, extra_data TEXT); CREATE TABLE session_messages (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp INTEGER NOT NULL, thought TEXT, toolCalls TEXT, actions TEXT, findings TEXT, plan TEXT, FOREIGN KEY(sessionId) REFERENCES sessions(id));`)
  const extra = metadata ? JSON.stringify({ owner: 'native', view: 'compact' }) : null
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('legacy_session', 'Legacy chat', 100, 200, 'web', 'contact-1', 'active', '/workspace', 'Other', extra)
  db.prepare('INSERT INTO session_messages VALUES (?,?,?,?,?,?,?,?,?,?)').run('legacy_message', 'legacy_session', 'user', content, 150, 'thought', JSON.stringify({ tool: 'none' }), JSON.stringify([{ type: 'note' }]), null, JSON.stringify({ steps: ['one'] }))
  db.close()
  return root
}

async function staged(server, origin, sourceRoot, secret) {
  const auth = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, auth)
  assert.equal(preview.status, 200)
  const stage = await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, auth)
  assert.equal(stage.status, 200)
  return { auth, preview: preview.body }
}

test('native chat-history cutover imports metadata transactionally and repeats idempotently', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-cutover-')
  const sourceRoot = sourceFixture()
  const secret = 'c'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, { origin })).status, 401)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal(confirmation.status, 200)
  assert.equal(confirmation.body.state, 'confirmed')
  const applied = await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)
  assert.equal(applied.status, 200)
  assert.equal(applied.body.state, 'applied')
  assert.equal(applied.body.sessionsImported, 1)
  assert.equal(applied.body.messagesImported, 1)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 1)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 1)
  assert.deepEqual(JSON.parse(server.db.prepare('SELECT metadata FROM chat_messages').get().metadata), { thought: 'thought', toolCalls: { tool: 'none' }, actions: [{ type: 'note' }], plan: { steps: ['one'] } })
  assert.deepEqual(JSON.parse(server.db.prepare('SELECT metadata FROM chat_sessions').get().metadata), { owner: 'native', view: 'compact' })
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId }, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)).status, 403)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history rejects staged corruption and conflicting existing IDs without partial writes', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-conflict-')
  const sourceRoot = sourceFixture()
  const secret = 'd'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  server.db.prepare('INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES (?,?,?,?)').run('legacy_session', 'conflict', 1, 1)
  const conflict = await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)
  assert.equal(conflict.status, 409)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 0)
  assert.equal(conflict.body.state, 'rolled-back')
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })

  const corruptData = makeTempDir('aica-agentd-chat-corrupt-')
  const corruptSource = sourceFixture()
  const corruptServer = new AgentdServer({ dataDir: corruptData, secret, logger: { log() {} } })
  const started = await corruptServer.start()
  const stagedResult = await staged(corruptServer, started.origin, corruptSource, secret)
  const stageFile = path.join(corruptData, '.migration-staging', stagedResult.preview.previewId, 'electron-chat-history')
  fs.appendFileSync(stageFile, 'tamper')
  const bad = await request(started.origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: stagedResult.preview.previewId, scope: 'chat-history' }, stagedResult.auth)
  assert.equal(bad.status, 409)
  await corruptServer.stop(); fs.rmSync(corruptData, { recursive: true, force: true }); fs.rmSync(corruptSource, { recursive: true, force: true })

  const oversizeData = makeTempDir('aica-agentd-chat-oversize-')
  const oversizeSource = sourceFixture({ content: 'x'.repeat(32 * 1024 + 1) })
  const oversizeServer = new AgentdServer({ dataDir: oversizeData, secret, logger: { log() {} } })
  const oversizeStarted = await oversizeServer.start()
  const oversizeStaged = await staged(oversizeServer, oversizeStarted.origin, oversizeSource, secret)
  const oversizeConfirm = await request(oversizeStarted.origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: oversizeStaged.preview.previewId, scope: 'chat-history' }, oversizeStaged.auth)
  assert.equal(oversizeConfirm.status, 400)
  await oversizeServer.stop(); fs.rmSync(oversizeData, { recursive: true, force: true }); fs.rmSync(oversizeSource, { recursive: true, force: true })
})

test('chat-history refuses SQLite WAL and SHM sidecars during staging and cutover', async () => {
  const sidecars = ['-wal', '-shm']
  for (const suffix of sidecars) {
    const dataDir = makeTempDir(`aica-agentd-chat-sidecar-preview-${suffix.slice(1)}-`)
    const sourceRoot = sourceFixture()
    const secret = 'm'.repeat(32)
    const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
    const { origin } = await server.start()
    fs.writeFileSync(path.join(sourceRoot, `chat_history.v2.db${suffix}`), 'uncheckpointed sidecar')
    const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, { authorization: `Bearer ${secret}` })
    assert.equal(preview.status, 409)
    assert.match(preview.body.error, /sidecar/i)
    await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
  }

  const dataDir = makeTempDir('aica-agentd-chat-sidecar-cutover-')
  const sourceRoot = sourceFixture()
  const secret = 'n'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  const { preview } = await staged(server, origin, sourceRoot, secret)
  const stagedPath = path.join(dataDir, '.migration-staging', preview.previewId, 'electron-chat-history-wal')
  fs.writeFileSync(stagedPath, 'uncheckpointed staged sidecar')
  const stagedSidecar = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal(stagedSidecar.status, 409)
  assert.match(stagedSidecar.body.error, /sidecar/i)
  fs.rmSync(stagedPath)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal(confirmation.status, 200)
  fs.writeFileSync(path.join(sourceRoot, 'chat_history.v2.db-wal'), 'uncheckpointed source sidecar')
  const sourceSidecar = await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)
  assert.equal(sourceSidecar.status, 409)
  assert.match(sourceSidecar.body.error, /sidecar/i)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history applies the shared migration secret-key denylist to session metadata', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-session-metadata-')
  const sourceRoot = sourceFixture()
  const sourceDb = new Database(path.join(sourceRoot, 'chat_history.v2.db'))
  sourceDb.prepare('UPDATE sessions SET extra_data = ? WHERE id = ?').run(JSON.stringify({ session: 'must-not-migrate' }), 'legacy_session')
  sourceDb.close()
  const secret = 'o'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal(confirmation.status, 400)
  assert.match(confirmation.body.error, /secret field refused/i)
  assert.match(confirmation.body.error, /session/i)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history cutover survives restart and rollback removes only imported rows', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-recovery-')
  const sourceRoot = sourceFixture()
  const secret = 'e'.repeat(32)
  let server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  let { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)).status, 200)
  await server.stop()
  server = new AgentdServer({ dataDir, secret, logger: { log() {} } }); ({ origin } = await server.start())
  assert.equal((await request(origin, 'GET', `/api/v1/continuity/chat-history/status?previewId=${preview.previewId}`, undefined, auth)).body.state, 'applied')
  const rolledBack = await request(origin, 'POST', '/api/v1/continuity/chat-history/rollback', { previewId: preview.previewId }, auth)
  assert.equal(rolledBack.status, 200)
  assert.equal(rolledBack.body.state, 'rolled-back')
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 0)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history rollback fails closed when an imported session gains a later child message', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-rollback-child-')
  const sourceRoot = sourceFixture()
  const secret = 'g'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)).status, 200)
  server.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,attachments,metadata,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('legacy_session', 'later_message', 'user', 'added after import', null, null, 300)
  const rollback = await request(origin, 'POST', '/api/v1/continuity/chat-history/rollback', { previewId: preview.previewId }, auth)
  assert.equal(rollback.status, 500)
  assert.equal(rollback.body.state, 'needs-recovery')
  assert.equal(rollback.body.manualRecoveryRequired, true)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 1)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get('legacy_session').count, 2)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history apply keeps recovery hold when post-commit status persistence fails', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-commit-status-failure-')
  const sourceRoot = sourceFixture()
  const secret = 'k'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  const persist = server.persistChatHistoryCutover
  server.persistChatHistoryCutover = function (record) {
    if (record.state === 'applied') throw new Error('status persistence failed after commit')
    return persist.call(this, record)
  }
  const applied = await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)
  assert.equal(applied.status, 500)
  assert.equal(applied.body.state, 'needs-recovery')
  assert.equal(applied.body.manualRecoveryRequired, true)
  assert.equal(server.migrationHold, true)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 1)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history restart recovery allows same-scope rollback and clears the hold', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-recovery-rollback-')
  const sourceRoot = sourceFixture()
  const secret = 'h'.repeat(32)
  let server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  let { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)).status, 200)
  server.db.prepare('UPDATE chat_history_cutovers SET state = ? WHERE preview_id = ?').run('needs-recovery', preview.previewId)
  await server.stop()
  server = new AgentdServer({ dataDir, secret, logger: { log() {} } }); ({ origin } = await server.start())
  assert.equal((await request(origin, 'GET', `/api/v1/continuity/chat-history/status?previewId=${preview.previewId}`, undefined, auth)).body.state, 'needs-recovery')
  assert.equal(server.migrationHold, true)
  const rollback = await request(origin, 'POST', '/api/v1/continuity/chat-history/rollback', { previewId: preview.previewId }, auth)
  assert.equal(rollback.status, 200)
  assert.equal(rollback.body.state, 'rolled-back')
  assert.equal(server.migrationHold, false)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 0)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history rollback retry completes after post-delete status persistence failure', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-rollback-status-failure-')
  const sourceRoot = sourceFixture()
  const secret = 'l'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const { auth, preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)).status, 200)
  const persist = server.persistChatHistoryCutover
  let failRollbackStatus = true
  server.persistChatHistoryCutover = function (record) {
    if (failRollbackStatus && record.state === 'rolled-back') {
      failRollbackStatus = false
      throw new Error('rollback status persistence failed after delete')
    }
    return persist.call(this, record)
  }
  const firstRollback = await request(origin, 'POST', '/api/v1/continuity/chat-history/rollback', { previewId: preview.previewId }, auth)
  assert.equal(firstRollback.status, 500)
  assert.equal(firstRollback.body.state, 'needs-recovery')
  assert.equal(server.migrationHold, true)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 0)
  const retry = await request(origin, 'POST', '/api/v1/continuity/chat-history/rollback', { previewId: preview.previewId }, auth)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.state, 'rolled-back')
  assert.equal(server.migrationHold, false)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count, 0)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('chat-history migration hold fences chat writes while generation admission is held', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-fence-')
  const sourceRoot = sourceFixture()
  const secret = 'f'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  server.migrationHold = true
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'blocked', title: 'blocked' }, auth)).status, 409)
  server.migrationHold = false
  const { preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  const release = server.beginActiveOperation()
  const applying = request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)
  for (let attempt = 0; attempt < 20 && !server.migrationHold; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(server.migrationHold, true)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'blocked', title: 'blocked' }, auth)).status, 409)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/legacy_session/generations/race/cancel', {}, auth)).status, 409)
  release()
  assert.equal((await applying).status, 200)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('settings and chat cutovers cannot claim or release each other’s migration hold', async () => {
  const dataDir = makeTempDir('aica-agentd-migration-owner-')
  const server = new AgentdServer({ dataDir, secret: 'j'.repeat(32), logger: { log() {} } })
  await server.start()
  assert.equal(server.claimMigrationOwner('settings-persona'), true)
  assert.equal(server.claimMigrationOwner('chat-history'), false)
  server.releaseMigrationOwner('chat-history', false)
  assert.equal(server.migrationOwner, true)
  assert.equal(server.migrationScope, 'settings-persona')
  server.releaseMigrationOwner('settings-persona', false)
  assert.equal(server.migrationOwner, false)
  assert.equal(server.migrationHold, false)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('chat session and add-message admissions span body reads before cutover drains', async () => {
  const dataDir = makeTempDir('aica-agentd-chat-admission-')
  const sourceRoot = sourceFixture()
  const secret = 'i'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  const { preview } = await staged(server, origin, sourceRoot, secret)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: preview.previewId, scope: 'chat-history' }, auth)
  const delayedSession = delayedRequest(origin, 'POST', '/api/v1/sessions', { id: 'held_session', title: 'Held session' }, auth)
  delayedSession.req.flushHeaders()
  await waitFor(() => server.activeOperations.size === 1)
  const applying = request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: preview.previewId, confirmationToken: confirmation.body.confirmationToken }, auth)
  await waitFor(() => server.migrationHold)
  assert.equal(server.activeOperations.size, 1)
  delayedSession.send()
  const [sessionResult, applied] = await Promise.all([delayedSession.response, applying])
  assert.equal(sessionResult.status, 201)
  assert.equal(applied.status, 200)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_sessions WHERE id = ?').get('held_session').count, 1)

  const second = await staged(server, origin, sourceRoot, secret)
  const secondConfirmation = await request(origin, 'POST', '/api/v1/continuity/chat-history/confirm', { previewId: second.preview.previewId, scope: 'chat-history' }, auth)
  assert.equal(secondConfirmation.status, 200)
  const delayedMessage = delayedRequest(origin, 'POST', '/api/v1/sessions/held_session/messages', { id: 'held_message', role: 'user', content: 'Held message' }, auth)
  delayedMessage.req.flushHeaders()
  await waitFor(() => server.activeOperations.size === 1)
  const secondApplying = request(origin, 'POST', '/api/v1/continuity/chat-history/apply', { previewId: second.preview.previewId, confirmationToken: secondConfirmation.body.confirmationToken }, auth)
  await waitFor(() => server.migrationHold)
  assert.equal(server.activeOperations.size, 1)
  delayedMessage.send()
  const [messageResult, secondApplied] = await Promise.all([delayedMessage.response, secondApplying])
  assert.equal(messageResult.status, 201)
  assert.equal(secondApplied.status, 200, JSON.stringify(secondApplied.body))
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE message_id = ?').get('held_message').count, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})
