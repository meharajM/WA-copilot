import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const dataDir = '/tmp/aica-autonomy-recovery-test'
vi.mock('electron', () => ({
  app: { getPath: () => dataDir, getName: () => 'aica', getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('electron-store', () => ({
  default: class TestStore { store: Record<string, string> = {}; get(key: string) { return this.store[key] } set(key: string, value: string) { this.store[key] = value } delete(key: string) { delete this.store[key] } }
}))

describe('autonomy recovery', () => {
  let supervisor: typeof import('../../src/main/services/AutonomousSupervisor').autonomousSupervisor

  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(dataDir, { recursive: true })
    ;({ autonomousSupervisor: supervisor } = await import('../../src/main/services/AutonomousSupervisor'))
  })

  it('rejects backups without the autonomy schema', () => {
    const invalid = path.join(dataDir, 'invalid.db')
    const db = new Database(invalid)
    db.exec('CREATE TABLE unrelated (id TEXT)')
    db.close()
    expect(() => supervisor.stageBackup(invalid)).toThrow('required autonomy tables')
    expect(fs.existsSync(path.join(dataDir, 'autonomy.db.restore'))).toBe(false)
  })

  it('uses WAL and creates autonomous-work indexes', () => {
    const db = new Database(path.join(dataDir, 'autonomy.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining(['idx_inbound_pending', 'idx_conversation_revision', 'idx_outbound_provider_id', 'idx_outbound_unresolved']))
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()).toEqual({ version: 1 })
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get()).toEqual({ version: 2 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_accounts', 'jobs')").all()).toHaveLength(2)
    db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status) VALUES (?,?,?,?,?)').run('job-projection-1', 'customer-1', 'hello', Date.now(), 'queued')
    expect(db.prepare('SELECT inbound_id, queue_key, status FROM jobs WHERE inbound_id = ?').get('job-projection-1')).toMatchObject({ queue_key: 'customer-1', status: 'queued' })
    db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('retrying', 'job-projection-1')
    expect(db.prepare('SELECT status, attempts FROM jobs WHERE inbound_id = ?').get('job-projection-1')).toMatchObject({ status: 'retrying', attempts: 1 })
    db.prepare('DELETE FROM inbound_events WHERE id = ?').run('job-projection-1')
    expect(db.prepare('SELECT 1 FROM jobs WHERE inbound_id = ?').get('job-projection-1')).toBeUndefined()
    db.close()
  })

  it('returns derived quality, delivery, editing, and cost metrics', () => {
    const metrics = supervisor.getMetrics(14) as Record<string, number>
    expect(metrics).toMatchObject({ groundedDecisionRate: 0, deliveryUnknown: 0, draftApprovalRate: 0, averageDraftEditingTimeMs: 0, estimatedCostPerResolvedConversation: 0, reviewedDecisions: 0, reviewAccuracy: 0, escalationPrecision: 0, recoveryDrills: 0, averageRecoveryTimeMs: 0 })
  })

  it('aggregates outbound usage by channel for owner visibility', () => {
    const db = new Database(path.join(dataDir, 'autonomy.db'))
    db.prepare('INSERT INTO usage_events (kind,amount,estimated_tokens,estimated_cost,channel,created_at) VALUES (?,?,?,?,?,?)').run('outbound', 1, 0, 0, 'twitter', Date.now())
    db.prepare('INSERT INTO usage_events (kind,amount,estimated_tokens,estimated_cost,channel,created_at) VALUES (?,?,?,?,?,?)').run('outbound', 1, 0, 0, 'twitter', Date.now())
    db.close()
    expect(supervisor.getChannelUsage(1)).toEqual(expect.arrayContaining([{ channel: 'twitter', amount: 2 }]))
  })

  it('surfaces bounded escalation contact and SLA configuration', () => {
    expect(supervisor.getHealth().escalation).toMatchObject({ contactConfigured: false, contact: null, slaMinutes: 60 })
    supervisor.setMode('draft', false)
    expect(() => supervisor.setMode('auto', true)).toThrow('AICA_ESCALATION_CONTACT')
    supervisor.setMode('observe', false)
  })

  it('persists owner quality reviews and derives review metrics', () => {
    const db = new Database(path.join(dataDir, 'autonomy.db'))
    const inboundId = 'quality-review-1'
    db.prepare('INSERT OR REPLACE INTO inbound_events (id,jid,content,received_at,status) VALUES (?,?,?,?,?)').run(inboundId, 'quality-customer', 'What are your hours?', Date.now(), 'sent')
    db.prepare('INSERT OR REPLACE INTO decisions (inbound_id,jid,decision,created_at,conversation_revision,graph_version,prompt_version,policy_version) VALUES (?,?,?,?,?,?,?,?)').run(inboundId, 'quality-customer', JSON.stringify({ text: 'We are open.', confidence: 0.9, grounding: 'grounded', escalated: false, sensitiveTopic: false, reason: 'grounded' }), Date.now(), 1, 'test', 'test', 'test')
    db.close()
    supervisor.reviewDecision(inboundId, 'correct', 'Verified against support policy')
    const readDb = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect(readDb.prepare('SELECT label, notes FROM quality_reviews WHERE inbound_id = ?').get(inboundId)).toEqual({ label: 'correct', notes: 'Verified against support policy' })
    readDb.close()
    expect(supervisor.getMetrics(14) as Record<string, number>).toMatchObject({ reviewedDecisions: 1, correctDecisions: 1, reviewAccuracy: 1 })
  })

  it('derives recovery duration from audited recovery actions', () => {
    const now = Date.now()
    const db = new Database(path.join(dataDir, 'autonomy.db'))
    db.prepare("INSERT INTO operator_actions (action, details, created_at) VALUES ('enter_recovery_mode', NULL, ?)").run(now - 5000)
    db.prepare("INSERT INTO operator_actions (action, details, created_at) VALUES ('clear_recovery_mode', NULL, ?)").run(now - 3000)
    db.close()
    expect(supervisor.getMetrics(14) as Record<string, number>).toMatchObject({ recoveryDrills: 1, averageRecoveryTimeMs: 2000 })
  })

  it('stages a valid backup and enters recovery hold', () => {
    const backup = path.join(dataDir, 'valid.db')
    const db = new Database(backup)
    db.exec('CREATE TABLE inbound_events (id TEXT); CREATE TABLE conversations (jid TEXT); CREATE TABLE decisions (id INTEGER)')
    db.close()
    const state = supervisor.stageBackup(backup)
    expect(state.recoveryMode).toBe(true)
    expect(state.paused).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'autonomy.db.restore'))).toBe(true)
    fs.rmSync(path.join(dataDir, 'autonomy.db.restore'), { force: true })
  })

  it('blocks resume during recovery until the hold is cleared', () => {
    expect(() => supervisor.resume()).toThrow('Recovery mode must be cleared')
    supervisor.clearRecoveryMode()
    expect(() => supervisor.resume()).not.toThrow()
    supervisor.stop()
  })

  it('deduplicates repeated inbound provider events', async () => {
    const message = { id: 'duplicate-1', from: 'customer-1', to: 'owner', content: 'Hello', timestamp: Date.now(), type: 'text' as const, isFromMe: false }
    supervisor.onMessage(message)
    supervisor.onMessage(message)
    await new Promise(resolve => setTimeout(resolve, 10))
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect((db.prepare('SELECT COUNT(*) AS count FROM inbound_events WHERE id = ?').get(message.id) as { count: number }).count).toBe(1)
    db.close()
  })

  it('durably rejects a new conversation after the admission cap', () => {
    const db = new Database(path.join(dataDir, 'autonomy.db'))
    const existing = (db.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number }).count
    const fillers = Array.from({ length: Math.max(0, 100 - existing) }, (_, index) => `capacity-filler-${index}`)
    for (const jid of fillers) db.prepare('INSERT OR IGNORE INTO conversations (jid, revision, updated_at) VALUES (?, 1, ?)').run(jid, Date.now())
    const id = 'capacity-limited-1'
    supervisor.onMessage({ id, from: 'capacity-customer', to: 'owner', content: 'What are your hours?', timestamp: Date.now(), type: 'text', isFromMe: false })
    expect((db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(id) as { status: string }).status).toBe('capacity_limited')
    db.prepare('DELETE FROM conversations WHERE jid LIKE ?').run('capacity-filler-%')
    db.prepare('DELETE FROM inbound_events WHERE id = ?').run(id)
    db.close()
  })

  it('routes normalized email events through the supervisor queue', async () => {
    supervisor.start()
    supervisor.onEmailMessage({ schemaVersion: 1, id: 'email-supervisor-1', channel: 'email', from: 'customer@example.com', to: 'support@example.com', content: 'What are your hours?', timestamp: Date.now(), type: 'text', isFromMe: false, conversationId: '<thread-1>', actor: 'customer' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect((db.prepare('SELECT channel, status, jid FROM inbound_events WHERE id = ?').get('email-supervisor-1') as { channel: string; status: string; jid: string })).toMatchObject({ channel: 'email', status: 'observed', jid: 'email:<thread-1>' })
    db.close()
    supervisor.stop()
  })

  it('escalates email attachments before autonomous generation', async () => {
    supervisor.setMode('draft', false)
    supervisor.start()
    supervisor.onEmailMessage({ schemaVersion: 1, id: 'email-attachment-review-1', channel: 'email', from: 'attachment@example.com', to: 'support@example.com', content: 'Please review the invoice', timestamp: Date.now(), type: 'text', isFromMe: false, conversationId: 'attachment-thread', actor: 'customer', attachments: [{ id: 'att-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: 42 }] })
    await new Promise(resolve => setTimeout(resolve, 10))
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect(db.prepare('SELECT status FROM inbound_events WHERE id = ?').get('email-attachment-review-1')).toEqual({ status: 'escalated' })
    expect((db.prepare('SELECT decision FROM decisions WHERE inbound_id = ?').get('email-attachment-review-1') as { decision: string }).decision).toContain('media_requires_human_review')
    db.close()
    supervisor.stop()
    supervisor.setMode('observe', false)
  })

  it('blocks opted-out email events before queueing', () => {
    const jid = 'email:opted-out@example.com'
    const queueDepth = supervisor.getState().queueDepth
    const db = new Database(path.join(dataDir, 'autonomy.db'))
    db.prepare("INSERT INTO consents (jid,opted_out,source,updated_at) VALUES (?,1,'test',?) ON CONFLICT(jid) DO UPDATE SET opted_out = 1").run(jid, Date.now())
    db.close()
    supervisor.onEmailMessage({ schemaVersion: 1, id: 'email-opted-out-1', channel: 'email', from: 'opted-out@example.com', to: 'support@example.com', content: 'Can you help?', timestamp: Date.now(), type: 'text', isFromMe: false, conversationId: 'opted-out@example.com', actor: 'customer' })
    const readDb = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect((readDb.prepare('SELECT status FROM inbound_events WHERE id = ?').get('email-opted-out-1') as { status: string }).status).toBe('opted_out')
    expect(supervisor.getState().queueDepth).toBe(queueDepth)
    readDb.close()
  })

  it('persists Meta lead evidence without messaging consent', () => {
    supervisor.recordMetaLead({ id: 'meta-lead:test-1', leadId: 'test-1', pageId: 'page-1', campaignId: 'campaign-1', messagingConsent: false, rawPayload: { field: 'leadgen' } })
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect(db.prepare('SELECT lead_id, campaign_id, messaging_consent FROM meta_leads WHERE id = ?').get('meta-lead:test-1')).toEqual({ lead_id: 'test-1', campaign_id: 'campaign-1', messaging_consent: 0 })
    db.close()
  })

  it('keeps new work queued during Pause All', () => {
    supervisor.start()
    supervisor.pause(true)
    const message = { id: 'paused-1', from: 'customer-paused', to: 'owner', content: 'Need help', timestamp: Date.now(), type: 'text' as const, isFromMe: false }
    supervisor.onMessage(message)
    expect(supervisor.getState().paused).toBe(true)
    expect(supervisor.getState().emergencyPaused).toBe(true)
    expect((new Database(path.join(dataDir, 'autonomy.db'), { readonly: true }).prepare('SELECT status FROM inbound_events WHERE id = ?').get(message.id) as { status: string }).status).toBe('queued')
    supervisor.resume()
    supervisor.stop()
  })

  it('aborts in-flight generation on global and conversation pause', () => {
    const generations = (supervisor as unknown as { generationControllers: Map<string, { jid: string; controller: AbortController }> }).generationControllers
    const globalController = new AbortController()
    generations.set('global-generation', { jid: 'global-pause-customer', controller: globalController })
    supervisor.pause(true)
    expect(globalController.signal.aborted).toBe(true)
    const conversationController = new AbortController()
    generations.set('conversation-generation', { jid: 'conversation-pause-customer', controller: conversationController })
    supervisor.pauseConversation('conversation-pause-customer')
    expect(conversationController.signal.aborted).toBe(true)
    generations.clear()
  })

  it('records opt-out before any autonomous response path', async () => {
    supervisor.start()
    const message = { id: 'optout-1', from: 'customer-optout', to: 'owner', content: 'STOP', timestamp: Date.now(), type: 'text' as const, isFromMe: false }
    supervisor.onMessage(message)
    await new Promise(resolve => setTimeout(resolve, 10))
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect((db.prepare('SELECT opted_out FROM consents WHERE jid = ?').get(message.from) as { opted_out: number }).opted_out).toBe(1)
    db.close()
    supervisor.stop()
  })

  it('rebuilds queued work after a supervisor reload', async () => {
    supervisor.start()
    supervisor.pause()
    const message = { id: 'restart-1', from: 'customer-restart', to: 'owner', content: 'Still need help', timestamp: Date.now(), type: 'text' as const, isFromMe: false }
    supervisor.onMessage(message)
    supervisor.onEmailMessage({ schemaVersion: 1, id: 'restart-email-1', channel: 'email', from: 'customer@example.com', to: 'support@example.com', content: 'Email still needs help', timestamp: Date.now(), type: 'text', isFromMe: false, subject: 'Follow-up', messageId: '<restart-email-1>', conversationId: '<restart-thread>' })
    expect(supervisor.getState().queueDepth).toBe(2)
    ;(supervisor as unknown as { db: Database.Database }).db.close()
    vi.resetModules()
    const reloaded = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    expect(reloaded.getState().queueDepth).toBe(2)
    expect(reloaded.getState().paused).toBe(true)
    reloaded.stop()
    ;(reloaded as unknown as { db: Database.Database }).db.close()
  })

  it('restarts drains for external-channel queues too', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const instance = activeSupervisor as unknown as { emailQueues: Map<string, unknown[]>; metaQueues: Map<string, unknown[]>; state: { status: string; paused: boolean } }
    instance.emailQueues.set('email:restart', [{}])
    instance.metaQueues.set('messenger:restart', [{}])
    instance.state.status = 'running'
    instance.state.paused = false
    vi.spyOn(activeSupervisor as unknown as { startHealthMonitor: () => void }, 'startHealthMonitor').mockImplementation(() => {})
    vi.spyOn(activeSupervisor as unknown as { drain: (jid: string) => Promise<void> }, 'drain').mockResolvedValue()
    const emailDrain = vi.spyOn(activeSupervisor as unknown as { drainEmail: (jid: string) => Promise<void> }, 'drainEmail').mockResolvedValue()
    const metaDrain = vi.spyOn(activeSupervisor as unknown as { drainMeta: (jid: string) => Promise<void> }, 'drainMeta').mockResolvedValue()
    activeSupervisor.recover()
    expect(emailDrain).toHaveBeenCalledWith('email:restart')
    expect(metaDrain).toHaveBeenCalledWith('messenger:restart')
    activeSupervisor.stop()
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('requeues delivery-unknown external messages on their original channel', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    const inboundId = 'retry-email-1'
    const jid = 'email:<retry-thread>'
    const message = { schemaVersion: 1, id: inboundId, channel: 'email', from: 'customer@example.com', to: 'support@example.com', content: 'Where are your hours?', timestamp: Date.now(), type: 'text', isFromMe: false, conversationId: '<retry-thread>' }
    db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel,payload) VALUES (?,?,?,?,?,?,?)').run(inboundId, jid, message.content, message.timestamp, 'delivery_unknown', 'email', JSON.stringify(message))
    db.prepare('INSERT INTO outbound_sends (inbound_id,provider_message_id,jid,content,sent_at,status,error) VALUES (?,?,?,?,?,?,?)').run(inboundId, null, jid, 'previous response', Date.now(), 'delivery-unknown', 'timeout')
    const emailDrain = vi.spyOn(activeSupervisor as unknown as { drainEmail: (conversationId: string) => Promise<void> }, 'drainEmail').mockResolvedValue()
    activeSupervisor.retryDelivery(inboundId)
    expect(emailDrain).toHaveBeenCalledWith(jid)
    expect((db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(inboundId) as { status: string }).status).toBe('queued')
    expect(db.prepare('SELECT 1 FROM outbound_sends WHERE inbound_id = ?').get(inboundId)).toBeUndefined()
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('reconciles Cloud delivery failures into the inbound record', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    const inboundId = 'cloud-delivery-failed-1'
    db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel) VALUES (?,?,?,?,?,?)').run(inboundId, 'customer-cloud-delivery', 'Hello', Date.now(), 'sent', 'whatsapp')
    db.prepare('INSERT INTO outbound_sends (inbound_id,provider_message_id,jid,content,sent_at,status,error) VALUES (?,?,?,?,?,?,?)').run(inboundId, 'wamid.failed-1', 'customer-cloud-delivery', 'Response', Date.now(), 'sent', null)
    activeSupervisor.onDeliveryUpdate({ providerMessageId: 'wamid.failed-1', status: 'failed', timestamp: Date.now() })
    expect((db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(inboundId) as { status: string }).status).toBe('delivery_failed')
    expect((db.prepare('SELECT status FROM outbound_sends WHERE inbound_id = ?').get(inboundId) as { status: string }).status).toBe('failed')
    expect(db.prepare('SELECT channel, status, inbound_id FROM delivery_events WHERE provider_message_id = ?').get('wamid.failed-1')).toMatchObject({ channel: 'whatsapp', status: 'failed', inbound_id: inboundId })
    activeSupervisor.onDeliveryUpdate({ providerMessageId: 'wamid.unknown-1', status: 'failed', timestamp: Date.now() })
    expect(db.prepare("SELECT action FROM operator_actions WHERE action = 'delivery_update_unmatched'").get()).toBeTruthy()
    expect(db.prepare('SELECT inbound_id FROM delivery_events WHERE provider_message_id = ?').get('wamid.unknown-1')).toMatchObject({ inbound_id: null })
    expect(activeSupervisor.listDeliveryHistory(100)).toEqual(expect.arrayContaining([expect.objectContaining({ providerMessageId: 'wamid.failed-1', channel: 'whatsapp', status: 'failed', inboundId })]))
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('durably expires pending drafts after their deadline', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    db.prepare('INSERT INTO drafts (inbound_id,jid,content,content_hash,conversation_revision,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('expired-draft-1', 'customer-expired-draft', 'Old draft', 'hash', 1, 'pending', Date.now() - 1, Date.now() - 1000)
    ;(activeSupervisor as unknown as { expireDrafts: () => void }).expireDrafts()
    expect((db.prepare('SELECT status FROM drafts WHERE inbound_id = ?').get('expired-draft-1') as { status: string }).status).toBe('expired')
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('retains active inbound work while pruning old terminal records', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000
    db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel) VALUES (?,?,?,?,?,?)').run('retention-terminal-1', 'retention-terminal', 'Old', old, 'failed', 'whatsapp')
    db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel) VALUES (?,?,?,?,?,?)').run('retention-active-1', 'retention-active', 'Queued', old, 'queued', 'whatsapp')
    db.prepare('INSERT INTO takeovers (jid,source,active,started_at,ended_at) VALUES (?,?,?,?,?)').run('retention-takeover-old', 'test', 0, old, old)
    db.prepare('INSERT INTO takeovers (jid,source,active,started_at,ended_at) VALUES (?,?,?,?,?)').run('retention-takeover-active', 'test', 1, old, null)
    ;(activeSupervisor as unknown as { pruneRetention: () => void }).pruneRetention()
    expect(db.prepare('SELECT 1 FROM inbound_events WHERE id = ?').get('retention-terminal-1')).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM inbound_events WHERE id = ?').get('retention-active-1')).toBeTruthy()
    expect(db.prepare('SELECT 1 FROM takeovers WHERE jid = ?').get('retention-takeover-old')).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM takeovers WHERE jid = ?').get('retention-takeover-active')).toBeTruthy()
    db.prepare('DELETE FROM inbound_events WHERE id = ?').run('retention-active-1')
    db.prepare('DELETE FROM takeovers WHERE jid LIKE ?').run('retention-takeover-%')
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('persists RAG provenance on grounded decisions', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const { RAGEngine } = await import('../../src/main/packages/rag-engine')
    const { MemoryService } = await import('../../src/main/services/MemoryService')
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    vi.spyOn(RAGEngine.getInstance(), 'search').mockResolvedValue([{ id: 1, file_name: 'hours.md', file_path: '/knowledge/hours.md', content: 'Open 9 to 5', rank: -1 }])
    vi.spyOn(MemoryService.getInstance(), 'search').mockResolvedValue([{ id: 'memory-hours', name: 'Business hours', type: 'policy', description: 'Open 9 to 5', observations: [], metadata: {}, createdAt: '' }])
    let generationOptions: { maxOutputTokens?: number; signal?: AbortSignal } | undefined
    ;(activeSupervisor as unknown as { gemini: { generateText: (_prompt: string, _context: string, options?: typeof generationOptions) => Promise<string> } }).gemini = { generateText: async (_prompt, _context, options) => { generationOptions = options; return '{"text":"We are open 9 to 5.","confidence":0.95,"grounding":"grounded"}' } }
    const decision = await (activeSupervisor as unknown as { decide: (message: unknown) => Promise<{ evidence?: unknown[]; grounding: string }> }).decide({ id: 'rag-evidence-1', from: 'customer-rag', to: 'owner', content: 'What are your hours?', timestamp: Date.now(), type: 'text', isFromMe: false })
    expect(decision.grounding).toBe('grounded')
    expect(decision.evidence).toEqual([{ fileName: 'hours.md', filePath: '/knowledge/hours.md', rank: -1 }])
    expect(decision.memoryEvidence).toEqual([{ id: 'memory-hours', name: 'Business hours', type: 'policy' }])
    expect(generationOptions?.maxOutputTokens).toBe(512)
    expect(generationOptions?.signal).toBeInstanceOf(AbortSignal)
    db.prepare('INSERT INTO decisions (inbound_id,jid,decision,created_at) VALUES (?,?,?,?)').run('rag-evidence-1', 'customer-rag', JSON.stringify(decision), Date.now())
    expect(activeSupervisor.listDecisionEvidence(10)).toEqual(expect.arrayContaining([expect.objectContaining({ inboundId: 'rag-evidence-1', decision: expect.objectContaining({ evidence: decision.evidence }) })]))
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('persists graph-run lifecycle and scoped thread identity', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    ;(activeSupervisor as unknown as { workflow: unknown }).workflow = { invoke: async () => ({ decision: { text: 'Hi', confidence: 0.9, grounding: 'grounded', escalated: false, sensitiveTopic: false, reason: 'test' } }) }
    await (activeSupervisor as unknown as { runDecision: (message: unknown) => Promise<unknown> }).runDecision({ schemaVersion: 1, id: 'graph-run-1', channel: 'email', businessId: 'business-1', channelAccountId: 'support@example.com', conversationId: 'thread-1', from: 'customer@example.com', to: 'support@example.com', content: 'Hello', timestamp: Date.now(), type: 'text', isFromMe: false })
    expect(db.prepare('SELECT status, thread_id, graph_version FROM graph_runs WHERE inbound_id = ?').get('graph-run-1')).toMatchObject({ status: 'completed', thread_id: 'business-1:email:support@example.com:thread-1', graph_version: 'autonomy-decision-v1' })
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('persists owner takeover and pauses that conversation', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const { whatsappService } = await import('../../src/main/whatsapp/WhatsAppService')
    ;(whatsappService as unknown as { connectionState: { phoneNumber: string | null } }).connectionState.phoneNumber = 'owner-1'
    const ownerMessage = { id: 'owner-takeover-1', from: 'owner-1', to: 'customer-1', content: 'I will take this', timestamp: Date.now(), type: 'text' as const, isFromMe: false }
    activeSupervisor.onMessage(ownerMessage)
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect((db.prepare('SELECT active FROM takeovers WHERE jid = ?').get(ownerMessage.from) as { active: number }).active).toBe(1)
    db.close()
    ;(whatsappService as unknown as { connectionState: { phoneNumber: string | null } }).connectionState.phoneNumber = null
    ;(activeSupervisor as unknown as { db: Database.Database }).db.close()
  })

  it('sends an allowlisted Cloud template once and records its provider ID', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    const inboundId = 'template-send-1'
    db.prepare('DELETE FROM supervisor_lease').run()
    db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status) VALUES (?,?,?,?,?)').run(inboundId, 'customer-template', 'Follow up', Date.now() - 25 * 60 * 60 * 1000, 'escalated')
    db.prepare('INSERT INTO conversations (jid,revision,updated_at) VALUES (?,?,?)').run('customer-template', 1, Date.now())
    db.prepare('INSERT OR IGNORE INTO approved_templates (name,language_code,category,active,updated_at) VALUES (?,?,?,?,?)').run('support_followup', 'en_US', 'utility', 1, Date.now())
    let calls = 0
    ;(activeSupervisor as unknown as { outboundTransport: unknown }).outboundTransport = { kind: 'cloud', sendText: vi.fn(), sendTemplate: async () => { calls++; return { success: true, providerMessageId: 'wamid.template-host' } } }
    activeSupervisor.start()
    ;(activeSupervisor as unknown as { outboundTransport: unknown }).outboundTransport = { kind: 'cloud', sendText: vi.fn(), sendTemplate: async () => { calls++; return { success: true, providerMessageId: 'wamid.template-host' } } }
    await activeSupervisor.sendApprovedTemplate(inboundId, 'support_followup', 'en_US')
    await activeSupervisor.sendApprovedTemplate(inboundId, 'support_followup', 'en_US')
    expect(calls).toBe(1)
    expect(db.prepare('SELECT status, provider_message_id, payload_hash FROM outbound_sends WHERE inbound_id = ?').get(inboundId)).toMatchObject({ status: 'sent', provider_message_id: 'wamid.template-host' })
    expect(db.prepare('SELECT channel, status, inbound_id FROM delivery_events WHERE provider_message_id = ?').get('wamid.template-host')).toMatchObject({ channel: 'whatsapp', status: 'sent', inbound_id: inboundId })
    activeSupervisor.stop()
    db.close()
  })

  it('rejects unapproved, inside-window, and opted-out template sends', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    db.prepare('DELETE FROM supervisor_lease').run()
    activeSupervisor.start()
    ;(activeSupervisor as unknown as { outboundTransport: unknown }).outboundTransport = { kind: 'cloud', sendText: vi.fn(), sendTemplate: vi.fn() }
    const insert = db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status) VALUES (?,?,?,?,?)')
    const conversation = db.prepare('INSERT INTO conversations (jid,revision,updated_at) VALUES (?,?,?)')
    insert.run('template-unapproved', 'customer-template-negative', 'Follow up', Date.now() - 25 * 60 * 60 * 1000, 'escalated')
    conversation.run('customer-template-negative', 1, Date.now())
    await expect(activeSupervisor.sendApprovedTemplate('template-unapproved', 'not-approved', 'en_US')).rejects.toThrow('not active')
    db.prepare('INSERT OR IGNORE INTO approved_templates (name,language_code,category,active,updated_at) VALUES (?,?,?,?,?)').run('support_followup', 'en_US', 'utility', 1, Date.now())
    insert.run('template-window', 'customer-template-window', 'Follow up', Date.now(), 'escalated')
    conversation.run('customer-template-window', 1, Date.now())
    await expect(activeSupervisor.sendApprovedTemplate('template-window', 'support_followup', 'en_US')).rejects.toThrow('service window')
    insert.run('template-optout', 'customer-template-optout', 'Follow up', Date.now() - 25 * 60 * 60 * 1000, 'escalated')
    conversation.run('customer-template-optout', 1, Date.now())
    db.prepare('INSERT INTO consents (jid,opted_out,source,updated_at) VALUES (?,?,?,?)').run('customer-template-optout', 1, 'test', Date.now())
    await expect(activeSupervisor.sendApprovedTemplate('template-optout', 'support_followup', 'en_US')).rejects.toThrow('opted out')
    expect((activeSupervisor as unknown as { outboundTransport: { sendTemplate: ReturnType<typeof vi.fn> } }).outboundTransport.sendTemplate).not.toHaveBeenCalled()
    activeSupervisor.stop()
    db.close()
  })

  it('refuses to start while another supervisor lease is fresh', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    db.prepare('INSERT INTO supervisor_lease (id,owner,heartbeat_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at').run('other-process', Date.now())
    const state = activeSupervisor.start()
    expect(state.paused).toBe(true)
    expect(state.lastError).toContain('Another supervisor instance owns the lease')
    db.prepare('DELETE FROM supervisor_lease').run()
    db.close()
  })

  it('increments the lease generation when acquiring a stale lease', async () => {
    vi.resetModules()
    const activeSupervisor = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    const db = (activeSupervisor as unknown as { db: Database.Database }).db
    db.prepare('INSERT INTO supervisor_lease (id,owner,generation,heartbeat_at) VALUES (1,?,?,?)').run('stale-process', 4, Date.now() - 10 * 60 * 1000)
    activeSupervisor.start()
    expect(db.prepare('SELECT owner, generation FROM supervisor_lease WHERE id = 1').get()).toMatchObject({ generation: 5 })
    activeSupervisor.stop()
    db.close()
  })
})
