import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { GeminiClient } from '../packages/core/index'
import { RAGEngine } from '../packages/rag-engine/index'
import { BusinessPersona } from '../packages/persona/index'
import { whatsappService, WhatsAppMessage } from '../whatsapp/WhatsAppService'
import { isSameWhatsAppIdentity } from '../utils/whatsapp'
import { classifyProviderError, draftContentHash, isAccountSpecificRequest, isAllowlistedSupportIntent, isAmbiguousSendError, isConfirmedPreSendTransientError, isOptInMessage, isOptOutMessage, isPromptInjection, isSensitiveSupportTopic, isStaleRevision, isWithinWhatsAppServiceWindow, parseAutonomyDecision } from './AutonomyDecision'
import { createAutonomyWorkflow, runAutonomyWorkflow, workflowThreadId, type WorkflowMessage } from './AutonomyWorkflow'
import { canEnableAutoMode, canRunBaileysAutoReply, evaluateAutonomyPolicy, isDispatchAllowed } from './AutonomyPolicy'
import { createWhatsAppOutboundTransport, type WhatsAppOutboundTransport } from './WhatsAppTransport'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { getChannelCapabilities, isValidNormalizedChannelMessage, withChannelScope, type ChannelMessage } from '../packages/omnichannel'
import { emailChannelService } from './EmailChannelService'
import { MetaMessagingTransport } from './MetaMessaging'
import { XDirectMessageTransport } from './XDirectMessages'
import { MemoryService } from './MemoryService'

export type AutonomyMode = 'observe' | 'draft' | 'auto'
export interface SupervisorState {
  mode: AutonomyMode
  responsePermission: boolean
  paused: boolean
  emergencyPaused: boolean
  recoveryMode: boolean
  status: 'stopped' | 'running' | 'degraded' | 'error'
  queueDepth: number
  activeJob: string | null
  lastProcessedMessage: string | null
  lastError: string | null
  escalations: number
  lastHealthCheck: number
  lastDeliveryStatus: string | null
  lastProviderMessageId: string | null
  lastDeliveryInboundId: string | null
  usageToday: { llmCalls: number; outboundMessages: number; estimatedCost: number }
}
export interface ResponseDecision {
  text: string | null
  confidence: number
  grounding: 'grounded' | 'not_grounded' | 'unavailable'
  escalated: boolean
  sensitiveTopic: boolean
  reason: string
  evidence?: Array<{ fileName: string; filePath: string; rank?: number }>
  memoryEvidence?: Array<{ id: string; name: string; type: string }>
}

export type QualityReviewLabel = 'correct' | 'incorrect' | 'unnecessary_escalation' | 'missed_escalation'

const GRAPH_VERSION = 'autonomy-decision-v1'
const PROMPT_VERSION = 'support-grounded-json-v1'
const POLICY_VERSION = 'host-gates-v1'
const AUTONOMY_SCHEMA_VERSION = 2

const DEFAULT_STATE: SupervisorState = {
  mode: 'observe', responsePermission: false, paused: false, emergencyPaused: false, recoveryMode: false,
  status: 'stopped', queueDepth: 0, activeJob: null, lastProcessedMessage: null,
  lastError: null, escalations: 0, lastHealthCheck: 0, lastDeliveryStatus: null, lastProviderMessageId: null, lastDeliveryInboundId: null, usageToday: { llmCalls: 0, outboundMessages: 0, estimatedCost: 0 }
}

function configuredCap(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 && value <= 100_000 ? value : fallback
}

const DAILY_LLM_CAP = configuredCap('AICA_DAILY_LLM_CAP', 100)
const DAILY_OUTBOUND_CAP = configuredCap('AICA_DAILY_OUTBOUND_CAP', 1000)
const MAX_ACTIVE_CONVERSATIONS = configuredCap('AICA_MAX_ACTIVE_CONVERSATIONS', 100)
const COST_PER_1K_TOKENS = Math.max(0, Number(process.env.AICA_LLM_COST_PER_1K_TOKENS) || 0)
const RETENTION_DAYS = configuredCap('AICA_RETENTION_DAYS', 90)
const ESCALATION_CONTACT = (process.env.AICA_ESCALATION_CONTACT || '').trim()
const ESCALATION_SLA_MINUTES = configuredCap('AICA_ESCALATION_SLA_MINUTES', 60)
const LLM_DATA_POLICY_APPROVED = /^(1|true|yes)$/i.test((process.env.AICA_LLM_DATA_POLICY_APPROVED || '').trim())
const BAILEYS_EXPERIMENTAL_APPROVED = /^(1|true|yes)$/i.test((process.env.AICA_BAILEYS_EXPERIMENTAL_APPROVED || '').trim())
const LEASE_TTL_MS = 60_000

export class AutonomousSupervisor extends EventEmitter {
  private static instance: AutonomousSupervisor
  private readonly db: Database.Database
  private readonly queues = new Map<string, WhatsAppMessage[]>()
  private readonly emailQueues = new Map<string, ChannelMessage[]>()
  private readonly metaQueues = new Map<string, ChannelMessage[]>()
  private readonly messageRevisions = new Map<string, number>()
  private readonly active = new Set<string>()
  private readonly generationControllers = new Map<string, { jid: string; controller: AbortController }>()
  private readonly pausedConversations = new Set<string>()
  private readonly storePath: string
  private state: SupervisorState = { ...DEFAULT_STATE }
  private gemini: GeminiClient | null = null
  private readonly workflow
  private outboundTransport: WhatsAppOutboundTransport
  private readonly metaTransport: MetaMessagingTransport | null
  private readonly xTransport: XDirectMessageTransport | null
  private healthTimer: NodeJS.Timeout | null = null
  private baileysDispatchBlocked = false
  private baileysWasConnected = false
  private lastRetentionAt = 0
  private readonly leaseOwner = randomUUID()
  private leaseGeneration = 0

  private constructor() {
    super()
    this.storePath = path.join(app.getPath('userData'), 'autonomy-state.json')
    const dbPath = path.join(app.getPath('userData'), 'autonomy.db')
    let restored = false
    const stagedPath = `${dbPath}.restore`
    if (fs.existsSync(stagedPath)) {
      try {
        const staged = new Database(stagedPath, { readonly: true })
        const valid = Boolean(staged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'").get())
        staged.close()
        if (valid) { if (fs.existsSync(dbPath)) fs.renameSync(dbPath, `${dbPath}.pre-restore-${Date.now()}`); fs.renameSync(stagedPath, dbPath); restored = true }
      } catch (error) { console.error('[Autonomy] Staged restore rejected:', error) }
    }
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_events (id TEXT PRIMARY KEY, jid TEXT NOT NULL, content TEXT, received_at INTEGER NOT NULL, status TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', payload TEXT);
      CREATE TABLE IF NOT EXISTS conversations (jid TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_accounts (business_id TEXT NOT NULL, channel TEXT NOT NULL, account_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (business_id, channel, account_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, inbound_id TEXT UNIQUE NOT NULL, queue_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS consents (jid TEXT PRIMARY KEY, opted_out INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approved_templates (name TEXT NOT NULL, language_code TEXT NOT NULL, category TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (name, language_code));
      CREATE TABLE IF NOT EXISTS conversation_messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, inbound_id TEXT UNIQUE NOT NULL, jid TEXT NOT NULL, decision TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_runs (id TEXT PRIMARY KEY, inbound_id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, graph_version TEXT NOT NULL, prompt_version TEXT NOT NULL, policy_version TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS outbound_sends (inbound_id TEXT PRIMARY KEY, provider_message_id TEXT, jid TEXT NOT NULL, content TEXT NOT NULL, sent_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, payload_hash TEXT);
      CREATE TABLE IF NOT EXISTS delivery_events (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_message_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, event_at INTEGER NOT NULL, inbound_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS retries (id INTEGER PRIMARY KEY AUTOINCREMENT, inbound_id TEXT NOT NULL, attempt INTEGER NOT NULL, error TEXT, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unread', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, amount INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0, channel TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS takeovers (jid TEXT PRIMARY KEY, source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, started_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE IF NOT EXISTS drafts (inbound_id TEXT PRIMARY KEY, jid TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, conversation_revision INTEGER NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS supervisor_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, heartbeat_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta_leads (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, page_id TEXT NOT NULL, form_id TEXT, ad_id TEXT, campaign_id TEXT, messaging_consent INTEGER NOT NULL DEFAULT 0, raw_payload TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_reviews (inbound_id TEXT PRIMARY KEY, label TEXT NOT NULL, notes TEXT, reviewed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_inbound_pending ON inbound_events(status, received_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_revision ON conversations(jid, revision);
      CREATE INDEX IF NOT EXISTS idx_graph_runs_inbound ON graph_runs(inbound_id);
      CREATE INDEX IF NOT EXISTS idx_outbound_provider_id ON outbound_sends(provider_message_id);
      CREATE INDEX IF NOT EXISTS idx_delivery_provider_id ON delivery_events(provider_message_id);
      CREATE INDEX IF NOT EXISTS idx_outbound_unresolved ON outbound_sends(status) WHERE status IN ('pending', 'authorized', 'sending', 'delivery-unknown');
      CREATE INDEX IF NOT EXISTS idx_quality_reviews_reviewed ON quality_reviews(reviewed_at);
      CREATE TRIGGER IF NOT EXISTS inbound_events_to_jobs_insert AFTER INSERT ON inbound_events BEGIN INSERT OR IGNORE INTO jobs (id,inbound_id,queue_key,status,created_at,updated_at) VALUES (NEW.id,NEW.id,NEW.jid,NEW.status,NEW.received_at,NEW.received_at); END;
      CREATE TRIGGER IF NOT EXISTS inbound_events_to_jobs_update AFTER UPDATE OF status ON inbound_events BEGIN UPDATE jobs SET status = NEW.status, attempts = attempts + CASE WHEN NEW.status = 'retrying' AND OLD.status <> 'retrying' THEN 1 ELSE 0 END, updated_at = NEW.received_at WHERE inbound_id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS inbound_events_to_jobs_delete AFTER DELETE ON inbound_events BEGIN DELETE FROM jobs WHERE inbound_id = OLD.id; END;
    `)
    for (const column of [
      `conversation_revision INTEGER NOT NULL DEFAULT 0`,
      `graph_version TEXT NOT NULL DEFAULT '${GRAPH_VERSION}'`,
      `prompt_version TEXT NOT NULL DEFAULT '${PROMPT_VERSION}'`,
      `policy_version TEXT NOT NULL DEFAULT '${POLICY_VERSION}'`
    ]) {
      try { this.db.exec(`ALTER TABLE decisions ADD COLUMN ${column}`) } catch { /* existing column */ }
    }
    try { this.db.exec('ALTER TABLE outbound_sends ADD COLUMN payload_hash TEXT') } catch { /* existing column */ }
    try { this.db.exec("ALTER TABLE inbound_events ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'") } catch { /* existing column */ }
    try { this.db.exec('ALTER TABLE inbound_events ADD COLUMN payload TEXT') } catch { /* existing column */ }
    try { this.db.exec('ALTER TABLE usage_events ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0') } catch { /* existing column */ }
    try { this.db.exec('ALTER TABLE usage_events ADD COLUMN estimated_cost REAL NOT NULL DEFAULT 0') } catch { /* existing column */ }
    try { this.db.exec('ALTER TABLE usage_events ADD COLUMN channel TEXT') } catch { /* existing column */ }
    try { this.db.exec('ALTER TABLE supervisor_lease ADD COLUMN generation INTEGER NOT NULL DEFAULT 0') } catch { /* existing column */ }
    this.db.prepare('INSERT OR IGNORE INTO jobs (id,inbound_id,queue_key,status,created_at,updated_at) SELECT id,id,jid,status,received_at,received_at FROM inbound_events').run()
    for (const version of [1, AUTONOMY_SCHEMA_VERSION]) this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now())
    try { this.state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(this.storePath, 'utf8')) } } catch { /* first run */ }
    if (restored) { this.state.recoveryMode = true; this.state.paused = true; this.state.status = 'degraded'; this.state.lastError = 'Restored backup requires review before resume' }
    this.restoreQueuedMessages()
    for (const row of this.db.prepare('SELECT jid FROM takeovers WHERE active = 1').all() as Array<{ jid: string }>) this.pausedConversations.add(row.jid)
    if (process.env.GOOGLE_API_KEY) this.gemini = new GeminiClient(process.env.GOOGLE_API_KEY)
    this.metaTransport = process.env.META_ACCESS_TOKEN && process.env.META_ACCOUNT_ID ? new MetaMessagingTransport({ accessToken: process.env.META_ACCESS_TOKEN, accountId: process.env.META_ACCOUNT_ID, apiVersion: process.env.META_GRAPH_API_VERSION }) : null
    this.xTransport = process.env.X_CONSUMER_KEY && process.env.X_CONSUMER_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET && process.env.X_ACCOUNT_ID ? new XDirectMessageTransport({ consumerKey: process.env.X_CONSUMER_KEY, consumerSecret: process.env.X_CONSUMER_SECRET, accessToken: process.env.X_ACCESS_TOKEN, accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET, accountId: process.env.X_ACCOUNT_ID }) : null
    this.workflow = createAutonomyWorkflow((message) => this.decide(message), new SqliteSaver(this.db))
    try { this.outboundTransport = createWhatsAppOutboundTransport() }
    catch (error) { const failure = error instanceof Error ? error.message : String(error); this.outboundTransport = { kind: 'cloud', sendText: async () => ({ success: false, error: failure }), sendTemplate: async () => ({ success: false, error: failure }) }; this.state.status = 'degraded'; this.state.lastError = failure }
  }

  static getInstance(): AutonomousSupervisor { return this.instance ??= new AutonomousSupervisor() }
  getState(): SupervisorState { return { ...this.state, queueDepth: [...this.queues.values(), ...this.emailQueues.values(), ...this.metaQueues.values()].reduce((n, q) => n + q.length, 0), usageToday: { llmCalls: this.usageCount('llm'), outboundMessages: this.usageCount('outbound'), estimatedCost: this.usageCost() } } }
  getHealth() { return { executionLocation: 'electron-main', transport: this.outboundTransport.kind, baileysExperimentalApproval: BAILEYS_EXPERIMENTAL_APPROVED, llmConfigured: this.gemini !== null, llmDataPolicyApproved: LLM_DATA_POLICY_APPROVED, channel: whatsappService.getConnectionState(), email: emailChannelService.getConnectionState(), rag: RAGEngine.getInstance().health(), memory: MemoryService.getInstance().getHealth(), supervisor: this.getState(), escalation: { contact: ESCALATION_CONTACT || null, contactConfigured: Boolean(ESCALATION_CONTACT), slaMinutes: ESCALATION_SLA_MINUTES }, memoryRss: process.memoryUsage().rss, uptime: process.uptime(), leaseHeld: this.hasLease(), checkedAt: Date.now() } }
  getMetrics(days = 14) {
    const safeDays = Number.isInteger(days) && days > 0 && days <= 90 ? days : 14
    const since = Date.now() - safeDays * 24 * 60 * 60 * 1000
    const base = this.db.prepare(`SELECT COUNT(*) AS inbound, SUM(CASE WHEN e.status = 'sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN e.status = 'escalated' THEN 1 ELSE 0 END) AS escalated, SUM(CASE WHEN e.status = 'draft' THEN 1 ELSE 0 END) AS drafts, SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed, COALESCE(AVG(d.created_at - e.received_at), 0) AS averageDecisionLatencyMs FROM inbound_events e LEFT JOIN decisions d ON d.inbound_id = e.id WHERE e.received_at >= ?`).get(since) as { inbound: number; sent: number; escalated: number; drafts: number; failed: number; averageDecisionLatencyMs: number }
    const decisions = this.db.prepare('SELECT decision FROM decisions WHERE created_at >= ?').all(since) as Array<{ decision: string }>
    const grounding = { grounded: 0, notGrounded: 0, unavailable: 0 }
    for (const row of decisions) { try { const value = JSON.parse(row.decision) as { grounding?: keyof typeof grounding }; if (value.grounding && value.grounding in grounding) grounding[value.grounding]++ } catch { /* malformed historical decisions are excluded */ } }
    const draftRows = this.db.prepare('SELECT inbound_id AS inboundId, status, created_at AS createdAt FROM drafts WHERE created_at >= ?').all(since) as Array<{ inboundId: string; status: string; createdAt: number }>
    const approvalTimes = new Map<string, number>()
    for (const row of this.db.prepare("SELECT details, created_at AS createdAt FROM operator_actions WHERE action = 'approve_draft' AND created_at >= ?").all(since) as Array<{ details: string | null; createdAt: number }>) { try { const inboundId = row.details ? (JSON.parse(row.details) as { inboundId?: string }).inboundId : undefined; if (inboundId) approvalTimes.set(inboundId, row.createdAt) } catch { /* malformed historical actions are excluded */ } }
    const editingTimes = draftRows.filter(row => row.status === 'approved' && approvalTimes.has(row.inboundId)).map(row => (approvalTimes.get(row.inboundId) as number) - row.createdAt)
    const approvedDrafts = draftRows.filter(row => row.status === 'approved').length
    const estimatedCost = (this.db.prepare('SELECT COALESCE(SUM(estimated_cost), 0) AS total FROM usage_events WHERE created_at >= ?').get(since) as { total: number }).total
    const deliveryUnknown = (this.db.prepare("SELECT COUNT(*) AS count FROM outbound_sends WHERE status = 'delivery-unknown' AND sent_at >= ?").get(since) as { count: number }).count
    const resolvedConversations = Number(base.sent || 0) + Number(base.escalated || 0)
    const quality = this.db.prepare('SELECT label, COUNT(*) AS count FROM quality_reviews WHERE reviewed_at >= ? GROUP BY label').all(since) as Array<{ label: QualityReviewLabel; count: number }>
    const qualityCounts = Object.fromEntries(quality.map(row => [row.label, Number(row.count)])) as Partial<Record<QualityReviewLabel, number>>
    const reviewedDecisions = quality.reduce((sum, row) => sum + Number(row.count), 0)
    const correctDecisions = qualityCounts.correct || 0
    const escalationReviews = (qualityCounts.correct || 0) + (qualityCounts.incorrect || 0) + (qualityCounts.unnecessary_escalation || 0) + (qualityCounts.missed_escalation || 0)
    const escalationPrecision = escalationReviews ? ((qualityCounts.correct || 0) + (qualityCounts.unnecessary_escalation || 0)) / escalationReviews : 0
    const recoveryActions = this.db.prepare("SELECT action, created_at AS createdAt FROM operator_actions WHERE action IN ('enter_recovery_mode', 'clear_recovery_mode') AND created_at >= ? ORDER BY created_at ASC").all(since) as Array<{ action: string; createdAt: number }>
    const recoveryStarts: number[] = []
    const recoveryDurations: number[] = []
    for (const action of recoveryActions) {
      if (action.action === 'enter_recovery_mode') recoveryStarts.push(action.createdAt)
      else if (recoveryStarts.length) recoveryDurations.push(Math.max(0, action.createdAt - (recoveryStarts.shift() as number)))
    }
    return { ...base, groundedDecisions: grounding.grounded, notGroundedDecisions: grounding.notGrounded, unavailableDecisions: grounding.unavailable, groundedDecisionRate: decisions.length ? grounding.grounded / decisions.length : 0, deliveryUnknown, approvedDrafts, draftApprovalRate: draftRows.length ? approvedDrafts / draftRows.length : 0, averageDraftEditingTimeMs: editingTimes.length ? editingTimes.reduce((sum, value) => sum + value, 0) / editingTimes.length : 0, estimatedCost, resolvedConversations, estimatedCostPerResolvedConversation: resolvedConversations ? estimatedCost / resolvedConversations : 0, reviewedDecisions, correctDecisions, incorrectDecisions: qualityCounts.incorrect || 0, unnecessaryEscalations: qualityCounts.unnecessary_escalation || 0, missedEscalations: qualityCounts.missed_escalation || 0, reviewAccuracy: reviewedDecisions ? correctDecisions / reviewedDecisions : 0, escalationPrecision, recoveryDrills: recoveryDurations.length, averageRecoveryTimeMs: recoveryDurations.length ? recoveryDurations.reduce((sum, value) => sum + value, 0) / recoveryDurations.length : 0 }
  }
  getChannelUsage(days = 1): Array<{ channel: string; amount: number }> {
    const safeDays = Number.isInteger(days) && days > 0 && days <= 90 ? days : 1
    return this.db.prepare('SELECT COALESCE(channel, \'unknown\') AS channel, SUM(amount) AS amount FROM usage_events WHERE kind = \'outbound\' AND created_at >= ? GROUP BY channel ORDER BY amount DESC').all(Date.now() - safeDays * 24 * 60 * 60 * 1000) as Array<{ channel: string; amount: number }>
  }

  async reconnectChannel(): Promise<SupervisorState> {
    this.audit('reconnect_channel')
    try { await whatsappService.connect(whatsappService.getConnectionState().phoneNumber || undefined); this.checkHealth(); return this.getState() }
    catch (error) { this.state.status = 'degraded'; this.state.lastError = error instanceof Error ? error.message : String(error); this.notifyOwner('failure', { error: this.state.lastError }); this.publish(); throw error }
  }

  start(): SupervisorState {
    try { this.outboundTransport = createWhatsAppOutboundTransport() } catch (error) { this.state.status = 'degraded'; this.state.paused = true; this.state.lastError = error instanceof Error ? error.message : String(error); this.audit('start_failed_transport'); this.publish(); return this.getState() }
    const block = this.autoReplyBlockReason()
    if (block) { this.state.status = 'degraded'; this.state.paused = true; this.state.lastError = block; this.audit('start_blocked_auto_policy'); this.publish(); return this.getState() }
    if (!this.acquireLease()) { this.publish(); return this.getState() }
    this.state.status = 'running'; this.state.paused = false; this.startHealthMonitor(); this.audit('start'); this.publish(); return this.getState()
  }
  stop(): SupervisorState {
    this.state.status = 'stopped'; this.state.paused = true
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }
    this.db.prepare('DELETE FROM supervisor_lease WHERE id = 1 AND owner = ? AND generation = ?').run(this.leaseOwner, this.leaseGeneration)
    this.audit('stop'); this.publish(); return this.getState()
  }
  pause(emergency = false): SupervisorState { this.state.paused = true; this.state.emergencyPaused ||= emergency; for (const { controller } of this.generationControllers.values()) controller.abort(); this.audit(emergency ? 'pause_all' : 'pause'); this.publish(); return this.getState() }
  private autoReplyBlockReason(): string | null {
    if (this.state.mode !== 'auto' || !this.state.responsePermission) return null
    if (!ESCALATION_CONTACT) return 'Configure AICA_ESCALATION_CONTACT before enabling Auto-reply'
    if (!LLM_DATA_POLICY_APPROVED) return 'Set AICA_LLM_DATA_POLICY_APPROVED=true after reviewing the approved provider and data handling'
    if (!canRunBaileysAutoReply(this.outboundTransport.kind, BAILEYS_EXPERIMENTAL_APPROVED)) return 'Baileys Auto-reply requires explicit experimental transport approval'
    return null
  }

  resume(): SupervisorState {
    if (this.state.recoveryMode) throw new Error('Recovery mode must be cleared before resume')
    const block = this.autoReplyBlockReason()
    if (block) { this.state.status = 'degraded'; this.state.paused = true; this.state.lastError = block; this.audit('resume_blocked_auto_policy'); this.publish(); return this.getState() }
    if (this.outboundTransport.kind === 'baileys' && whatsappService.getConnectionState().status !== 'connected') { this.state.status = 'degraded'; this.state.lastError = `WhatsApp channel is ${whatsappService.getConnectionState().status}`; this.audit('resume_blocked_channel'); this.publish(); return this.getState() }
    this.baileysDispatchBlocked = false
    this.state.paused = false; this.state.emergencyPaused = false; this.audit('resume'); this.publish()
    for (const jid of this.queues.keys()) void this.drain(jid)
    for (const jid of this.emailQueues.keys()) void this.drainEmail(jid)
    for (const jid of this.metaQueues.keys()) void this.drainMeta(jid)
    return this.getState()
  }
  enterRecoveryMode(reason = 'backup_restore'): SupervisorState { this.state.recoveryMode = true; this.state.paused = true; this.state.status = 'degraded'; this.state.lastError = `Recovery hold: ${reason}`; this.audit('enter_recovery_mode', { reason }); this.notifyOwner('recovery', { reason }); this.publish(); return this.getState() }
  clearRecoveryMode(): SupervisorState { this.state.recoveryMode = false; this.state.paused = true; this.state.lastError = null; this.audit('clear_recovery_mode'); this.publish(); return this.getState() }
  stageBackup(backupPath: string): SupervisorState {
    const source = path.resolve(backupPath)
    const destination = path.join(app.getPath('userData'), 'autonomy.db.restore')
    if (!fs.existsSync(source) || path.extname(source) !== '.db') throw new Error('Select an autonomy SQLite backup (.db)')
    const candidate = new Database(source, { readonly: true })
    const valid = (candidate.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('inbound_events','conversations','decisions')").get() as { count: number }).count === 3
    candidate.close()
    if (!valid) throw new Error('Backup does not contain the required autonomy tables')
    fs.copyFileSync(source, destination)
    return this.enterRecoveryMode('backup_staged_restart_required')
  }
  pauseConversation(jid: string): SupervisorState { this.pausedConversations.add(jid); for (const generation of this.generationControllers.values()) if (generation.jid === jid) generation.controller.abort(); this.audit('pause_conversation', { jid }); return this.getState() }
  resumeConversation(jid: string): SupervisorState { const block = this.autoReplyBlockReason(); if (block) { this.state.status = 'degraded'; this.state.lastError = block; this.audit('resume_conversation_blocked_auto_policy', { jid }); this.publish(); return this.getState() }; this.pausedConversations.delete(jid); this.db.prepare("UPDATE takeovers SET active = 0, ended_at = ? WHERE jid = ?").run(Date.now(), jid); this.audit('resume_conversation', { jid }); if (jid.startsWith('email:')) void this.drainEmail(jid); else if (jid.startsWith('instagram:') || jid.startsWith('messenger:') || jid.startsWith('twitter:')) void this.drainMeta(jid); else void this.drain(jid); return this.getState() }
  setMode(mode: AutonomyMode, responsePermission: boolean): SupervisorState {
    if (!canEnableAutoMode(this.state.mode, mode)) throw new Error('Enable Draft mode before Auto-reply')
    if (mode === 'auto' && responsePermission && !ESCALATION_CONTACT) throw new Error('Configure AICA_ESCALATION_CONTACT before enabling Auto-reply')
    if (mode === 'auto' && responsePermission && !LLM_DATA_POLICY_APPROVED) throw new Error('Set AICA_LLM_DATA_POLICY_APPROVED=true after reviewing the approved provider and data handling')
    if (mode === 'auto' && responsePermission && !canRunBaileysAutoReply(this.outboundTransport.kind, BAILEYS_EXPERIMENTAL_APPROVED)) throw new Error('Set AICA_BAILEYS_EXPERIMENTAL_APPROVED=true only after reviewing the Baileys/libsignal security and licensing risk')
    this.state.mode = mode; this.state.responsePermission = mode === 'auto' && responsePermission
    this.audit('set_mode', { mode, responsePermission: this.state.responsePermission }); this.publish(); return this.getState()
  }

  onMessage(message: WhatsAppMessage): void {
    if (message.isFromMe) return
    this.ensureChannelAccount({ channel: 'whatsapp', businessId: message.businessId, channelAccountId: message.channelAccountId, to: message.to })
    if (isSameWhatsAppIdentity(message.from, whatsappService.getConnectionState().phoneNumber)) {
      this.db.prepare("INSERT INTO takeovers (jid,source,active,started_at,ended_at) VALUES (?, 'owner_message', 1, ?, NULL) ON CONFLICT(jid) DO UPDATE SET active = 1, source = 'owner_message', started_at = excluded.started_at, ended_at = NULL").run(message.from, Date.now())
      this.pauseConversation(message.from)
      this.emit('decision', { message, decision: { text: null, confidence: 1, grounding: 'unavailable', escalated: false, sensitiveTopic: false, reason: 'human_takeover_detected' } })
      return
    }
    const existing = this.db.prepare('SELECT id FROM inbound_events WHERE id = ?').get(message.id)
    if (existing) return
    if (!this.admitConversation(message.id, message.from, message.content, message.timestamp, 'whatsapp', message)) return
    const revision = this.db.transaction(() => {
      this.db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel,payload) VALUES (?,?,?,?,?,?,?)').run(message.id, message.from, message.content, message.timestamp, 'queued', 'whatsapp', JSON.stringify(message))
      this.db.prepare(`
        INSERT INTO conversations (jid, revision, updated_at) VALUES (?, 1, ?)
        ON CONFLICT(jid) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at
      `).run(message.from, Date.now())
      return (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(message.from) as { revision: number }).revision
    })()
    this.messageRevisions.set(message.id, revision)
    this.db.prepare('INSERT OR IGNORE INTO conversation_messages (id,jid,role,content,timestamp) VALUES (?,?,?,?,?)').run(message.id, message.from, 'customer', message.content, message.timestamp)
    this.db.prepare("UPDATE drafts SET status = 'superseded' WHERE jid = ? AND status = 'pending'").run(message.from)
    const optedOut = this.db.prepare('SELECT opted_out FROM consents WHERE jid = ? AND opted_out = 1').get(message.from)
    if (optedOut && isOptInMessage(message.content)) {
      this.db.prepare('UPDATE consents SET opted_out = 0, source = ?, updated_at = ? WHERE jid = ?').run('customer_opt_in', Date.now(), message.from)
    } else if (optedOut) {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('opted_out', message.id)
      this.publish()
      return
    }
    const queue = this.queues.get(message.from) ?? []
    queue.push(message); this.queues.set(message.from, queue); this.publish()
    void this.drain(message.from)
  }

  onEmailMessage(message: ChannelMessage): void {
    message = withChannelScope(message)
    if (!isValidNormalizedChannelMessage(message) || message.channel !== 'email' || message.isFromMe) return
    this.ensureChannelAccount(message)
    const jid = `email:${message.conversationId || message.from}`
    if (this.db.prepare('SELECT id FROM inbound_events WHERE id = ?').get(message.id)) return
    if (!this.admitConversation(message.id, jid, message.content, message.timestamp, 'email', message)) return
    const revision = this.db.transaction(() => {
      this.db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel,payload) VALUES (?,?,?,?,?,?,?)').run(message.id, jid, message.content, message.timestamp, 'queued', 'email', JSON.stringify(message))
      this.db.prepare('INSERT INTO conversations (jid, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT(jid) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at').run(jid, Date.now())
      return (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(jid) as { revision: number }).revision
    })()
    this.messageRevisions.set(message.id, revision)
    this.db.prepare('INSERT OR IGNORE INTO conversation_messages (id,jid,role,content,timestamp) VALUES (?,?,?,?,?)').run(message.id, jid, 'customer', message.content, message.timestamp)
    this.db.prepare("UPDATE drafts SET status = 'superseded' WHERE jid = ? AND status = 'pending'").run(jid)
    const optedOut = this.db.prepare('SELECT opted_out FROM consents WHERE jid = ? AND opted_out = 1').get(jid)
    if (optedOut && isOptInMessage(message.content)) this.db.prepare('UPDATE consents SET opted_out = 0, source = ?, updated_at = ? WHERE jid = ?').run('customer_opt_in', Date.now(), jid)
    else if (optedOut || isOptOutMessage(message.content)) {
      if (isOptOutMessage(message.content)) this.db.prepare("INSERT INTO consents (jid,opted_out,source,updated_at) VALUES (?,1,'customer_message',?) ON CONFLICT(jid) DO UPDATE SET opted_out = 1, source = excluded.source, updated_at = excluded.updated_at").run(jid, Date.now())
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('opted_out', message.id)
      this.publish()
      return
    }
    const queue = this.emailQueues.get(jid) ?? []
    queue.push(message); this.emailQueues.set(jid, queue); this.publish()
    void this.drainEmail(jid)
  }

  onMetaMessage(message: ChannelMessage): void {
    message = withChannelScope(message)
    const jid = `${message.channel}:${message.conversationId || message.from}`
    if (!isValidNormalizedChannelMessage(message) || !['instagram', 'messenger', 'twitter'].includes(message.channel)) return
    this.ensureChannelAccount(message)
    if (message.isFromMe) {
      this.db.prepare("INSERT INTO takeovers (jid,source,active,started_at,ended_at) VALUES (?, 'owner_message', 1, ?, NULL) ON CONFLICT(jid) DO UPDATE SET active = 1, source = 'owner_message', started_at = excluded.started_at, ended_at = NULL").run(jid, Date.now())
      this.pauseConversation(jid)
      return
    }
    if (this.db.prepare('SELECT id FROM inbound_events WHERE id = ?').get(message.id)) return
    if (!this.admitConversation(message.id, jid, message.content, message.timestamp, message.channel, message)) return
    const revision = this.db.transaction(() => {
      this.db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel,payload) VALUES (?,?,?,?,?,?,?)').run(message.id, jid, message.content, message.timestamp, 'queued', message.channel, JSON.stringify(message))
      this.db.prepare('INSERT INTO conversations (jid, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT(jid) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at').run(jid, Date.now())
      return (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(jid) as { revision: number }).revision
    })()
    this.messageRevisions.set(message.id, revision)
    this.db.prepare('INSERT OR IGNORE INTO conversation_messages (id,jid,role,content,timestamp) VALUES (?,?,?,?,?)').run(message.id, jid, 'customer', message.content, message.timestamp)
    const optedOut = this.db.prepare('SELECT opted_out FROM consents WHERE jid = ? AND opted_out = 1').get(jid)
    if (optedOut && isOptInMessage(message.content)) this.db.prepare('UPDATE consents SET opted_out = 0, source = ?, updated_at = ? WHERE jid = ?').run('customer_opt_in', Date.now(), jid)
    else if (optedOut || isOptOutMessage(message.content)) {
      if (isOptOutMessage(message.content)) this.db.prepare("INSERT INTO consents (jid,opted_out,source,updated_at) VALUES (?,1,'customer_message',?) ON CONFLICT(jid) DO UPDATE SET opted_out = 1, source = excluded.source, updated_at = excluded.updated_at").run(jid, Date.now())
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('opted_out', message.id); this.publish(); return
    }
    const queue = this.metaQueues.get(jid) ?? []
    queue.push(message); this.metaQueues.set(jid, queue); this.publish()
    void this.drainMeta(jid)
  }

  recordMetaLead(lead: { id: string; leadId: string; pageId?: string; formId?: string; adId?: string; campaignId?: string; messagingConsent: false; rawPayload: unknown }): void {
    if (!lead.id || !lead.leadId || !lead.pageId) return
    this.db.prepare('INSERT OR IGNORE INTO meta_leads (id,lead_id,page_id,form_id,ad_id,campaign_id,messaging_consent,raw_payload,received_at) VALUES (?,?,?,?,?,?,0,?,?)').run(lead.id, lead.leadId, lead.pageId, lead.formId ?? null, lead.adId ?? null, lead.campaignId ?? null, JSON.stringify(lead.rawPayload), Date.now())
    this.audit('meta_lead_received', { id: lead.id, leadId: lead.leadId, pageId: lead.pageId })
  }

  /** Rebuild in-memory queues after an Electron restart without replaying completed work. */
  recover(): void {
    if (this.state.status === 'running') this.startHealthMonitor()
    if (this.state.status === 'running' && !this.state.paused) {
      for (const jid of this.queues.keys()) void this.drain(jid)
      for (const jid of this.emailQueues.keys()) void this.drainEmail(jid)
      for (const jid of this.metaQueues.keys()) void this.drainMeta(jid)
    }
    this.publish()
  }

  onDeliveryUpdate(update: { providerMessageId: string; status: string; timestamp: number; channel?: string }): void {
    const channels = new Set(['whatsapp', 'email', 'instagram', 'messenger', 'twitter'])
    if (!update.providerMessageId || !Number.isFinite(update.timestamp) || !['sent', 'delivered', 'read', 'failed'].includes(update.status) || (update.channel !== undefined && !channels.has(update.channel))) {
      this.audit('delivery_update_invalid', { providerMessageId: update.providerMessageId, status: update.status, channel: update.channel })
      return
    }
    const eventStatus = update.status
    const status = update.status === 'failed' ? 'failed' : update.status === 'delivered' || update.status === 'read' ? 'delivered' : 'sent'
    const channel = update.channel || 'whatsapp'
    const record = this.db.prepare('SELECT inbound_id, status AS currentStatus FROM outbound_sends WHERE provider_message_id = ?').get(update.providerMessageId) as { inbound_id: string; currentStatus: string } | undefined
    const duplicate = this.db.prepare('SELECT 1 FROM delivery_events WHERE provider_message_id = ? AND channel = ? AND status = ? AND event_at = ? LIMIT 1').get(update.providerMessageId, channel, eventStatus, update.timestamp)
    if (!duplicate) this.db.prepare('INSERT INTO delivery_events (provider_message_id,channel,status,event_at,inbound_id,created_at) VALUES (?,?,?,?,?,?)').run(update.providerMessageId, channel, eventStatus, update.timestamp, record?.inbound_id ?? null, Date.now())
    else this.audit('delivery_update_duplicate', { providerMessageId: update.providerMessageId, channel, status: eventStatus, timestamp: update.timestamp })
    const rank: Record<string, number> = { sending: 0, 'delivery-unknown': 1, sent: 1, failed: 2, delivered: 3 }
    const advances = !record || (rank[status] ?? -1) > (rank[record.currentStatus] ?? -1)
    const result = advances ? this.db.prepare('UPDATE outbound_sends SET status = ?, sent_at = ? WHERE provider_message_id = ?').run(status, update.timestamp, update.providerMessageId) : { changes: 0 }
    if (record && !advances) this.audit('delivery_update_stale', { providerMessageId: update.providerMessageId, currentStatus: record.currentStatus, status })
    if (!record) { this.audit('delivery_update_unmatched', { providerMessageId: update.providerMessageId, status }); return }
    if (!advances || result.changes === 0) { this.publish(); return }
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run(status === 'failed' ? 'delivery_failed' : status, record.inbound_id)
    this.state.lastDeliveryStatus = status
    this.state.lastProviderMessageId = update.providerMessageId
    this.state.lastDeliveryInboundId = record.inbound_id
    if (status === 'failed') { this.state.lastError = `WhatsApp delivery failed for ${update.providerMessageId}`; this.notifyOwner('failure', { messageId: record.inbound_id, providerMessageId: update.providerMessageId, error: this.state.lastError }); this.emit('failure', { messageId: record.inbound_id, error: this.state.lastError }) }
    this.publish()
  }

  retryDelivery(inboundId: string): SupervisorState {
    const record = this.db.prepare('SELECT jid, content, sent_at, status FROM outbound_sends WHERE inbound_id = ?').get(inboundId) as { jid: string; content: string; sent_at: number; status: string } | undefined
    if (!record || record.status !== 'delivery-unknown') throw new Error('Only delivery-unknown messages can be retried')
    const inbound = this.db.prepare('SELECT channel, payload FROM inbound_events WHERE id = ?').get(inboundId) as { channel: string; payload: string | null } | undefined
    let message: ChannelMessage | WhatsAppMessage | null = null
    try { if (inbound?.payload) message = JSON.parse(inbound.payload) as ChannelMessage | WhatsAppMessage } catch { /* fall back to the durable outbound record */ }
    if (!message) message = { id: inboundId, from: record.jid, to: whatsappService.getConnectionState().phoneNumber || '', content: record.content, timestamp: record.sent_at, type: 'text', isFromMe: false }
    this.db.prepare('DELETE FROM outbound_sends WHERE inbound_id = ?').run(inboundId)
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('queued', inboundId)
    if (inbound?.channel === 'email') { const queue = this.emailQueues.get(record.jid) ?? []; queue.unshift(message as ChannelMessage); this.emailQueues.set(record.jid, queue) }
    else if (inbound?.channel === 'instagram' || inbound?.channel === 'messenger' || inbound?.channel === 'twitter') { const queue = this.metaQueues.get(record.jid) ?? []; queue.unshift(message as ChannelMessage); this.metaQueues.set(record.jid, queue) }
    else { const queue = this.queues.get(record.jid) ?? []; queue.unshift(message as WhatsAppMessage); this.queues.set(record.jid, queue) }
    this.audit('retry_delivery_unknown', { inboundId }); this.publish()
    if (inbound?.channel === 'email') void this.drainEmail(record.jid)
    else if (inbound?.channel === 'instagram' || inbound?.channel === 'messenger' || inbound?.channel === 'twitter') void this.drainMeta(record.jid)
    else void this.drain(record.jid)
    return this.getState()
  }

  quarantineDelivery(inboundId: string): SupervisorState {
    const result = this.db.prepare('UPDATE outbound_sends SET status = ? WHERE inbound_id = ? AND status = ?').run('quarantined', inboundId, 'delivery-unknown')
    if (result.changes === 0) throw new Error('Only delivery-unknown messages can be quarantined')
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('quarantined', inboundId)
    this.audit('quarantine_delivery_unknown', { inboundId }); this.publish()
    return this.getState()
  }

  cancelOutbound(inboundId: string): SupervisorState {
    const result = this.db.prepare("UPDATE outbound_sends SET status = ? WHERE inbound_id = ? AND status IN ('pending', 'authorized')").run('cancelled', inboundId)
    if (result.changes === 0) throw new Error('Only pending or authorized messages can be cancelled')
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('cancelled', inboundId)
    this.audit('cancel_outbound', { inboundId }); this.publish()
    return this.getState()
  }

  registerApprovedTemplate(name: string, languageCode: string, category: string): Array<{ name: string; languageCode: string; category: string }> {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name) || !/^[a-zA-Z0-9_-]{2,20}$/.test(languageCode) || !/^[a-zA-Z0-9_.-]{1,40}$/.test(category)) throw new Error('Invalid template fields')
    this.db.prepare(`INSERT INTO approved_templates (name, language_code, category, active, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(name, language_code) DO UPDATE SET category = excluded.category, active = 1, updated_at = excluded.updated_at`).run(name, languageCode, category, Date.now())
    this.audit('register_approved_template', { name, languageCode, category })
    return this.listApprovedTemplates()
  }

  revokeApprovedTemplate(name: string, languageCode: string): Array<{ name: string; languageCode: string; category: string }> {
    this.db.prepare('UPDATE approved_templates SET active = 0, updated_at = ? WHERE name = ? AND language_code = ?').run(Date.now(), name, languageCode)
    this.audit('revoke_approved_template', { name, languageCode })
    return this.listApprovedTemplates()
  }

  listApprovedTemplates(): Array<{ name: string; languageCode: string; category: string }> {
    return (this.db.prepare('SELECT name, language_code AS languageCode, category FROM approved_templates WHERE active = 1 ORDER BY name, language_code').all() as Array<{ name: string; languageCode: string; category: string }>)
  }

  listTakeovers(): Array<{ jid: string; source: string; startedAt: number }> {
    return this.db.prepare('SELECT jid, source, started_at AS startedAt FROM takeovers WHERE active = 1 ORDER BY started_at DESC').all() as Array<{ jid: string; source: string; startedAt: number }>
  }

  listDrafts(): Array<{ inboundId: string; jid: string; content: string; contentHash: string; expiresAt: number; status: string }> {
    return this.db.prepare("SELECT inbound_id AS inboundId, jid, content, content_hash AS contentHash, expires_at AS expiresAt, status FROM drafts WHERE status = 'pending' AND expires_at > ? ORDER BY created_at").all(Date.now()) as Array<{ inboundId: string; jid: string; content: string; contentHash: string; expiresAt: number; status: string }>
  }

  listUnresolvedOutbound(): Array<{ inboundId: string; jid: string; content: string; providerMessageId: string | null; sentAt: number; status: string; error: string | null }> {
    return this.db.prepare("SELECT inbound_id AS inboundId, jid, content, provider_message_id AS providerMessageId, sent_at AS sentAt, status, error FROM outbound_sends WHERE status IN ('sending', 'delivery-unknown', 'failed') ORDER BY sent_at DESC LIMIT 50").all() as Array<{ inboundId: string; jid: string; content: string; providerMessageId: string | null; sentAt: number; status: string; error: string | null }>
  }

  listDecisionEvidence(limit = 50): Array<{ inboundId: string; jid: string; createdAt: number; decision: ResponseDecision }> {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50
    const rows = this.db.prepare('SELECT inbound_id AS inboundId, jid, created_at AS createdAt, decision FROM decisions ORDER BY created_at DESC LIMIT ?').all(safeLimit) as Array<{ inboundId: string; jid: string; createdAt: number; decision: string }>
    return rows.flatMap(row => { try { return [{ inboundId: row.inboundId, jid: row.jid, createdAt: row.createdAt, decision: JSON.parse(row.decision) as ResponseDecision }] } catch { return [] } })
  }

  reviewDecision(inboundId: string, label: QualityReviewLabel, notes = ''): SupervisorState {
    if (!['correct', 'incorrect', 'unnecessary_escalation', 'missed_escalation'].includes(label)) throw new Error('Invalid quality review label')
    if (!this.db.prepare('SELECT 1 FROM decisions WHERE inbound_id = ?').get(inboundId)) throw new Error('Decision not found')
    const boundedNotes = notes.slice(0, 2000)
    this.db.prepare('INSERT INTO quality_reviews (inbound_id,label,notes,reviewed_at) VALUES (?,?,?,?) ON CONFLICT(inbound_id) DO UPDATE SET label = excluded.label, notes = excluded.notes, reviewed_at = excluded.reviewed_at').run(inboundId, label, boundedNotes || null, Date.now())
    this.audit('review_decision', { inboundId, label })
    return this.getState()
  }

  listDeliveryHistory(limit = 50): Array<{ providerMessageId: string; channel: string; status: string; eventAt: number; inboundId: string | null }> {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50
    return this.db.prepare('SELECT provider_message_id AS providerMessageId, channel, status, event_at AS eventAt, inbound_id AS inboundId FROM delivery_events ORDER BY event_at DESC LIMIT ?').all(safeLimit) as Array<{ providerMessageId: string; channel: string; status: string; eventAt: number; inboundId: string | null }>
  }

  private recordInitialDelivery(providerMessageId: string | undefined, channel: string, inboundId: string): void {
    if (!providerMessageId) return
    this.db.prepare('INSERT INTO delivery_events (provider_message_id,channel,status,event_at,inbound_id,created_at) VALUES (?,?,?,?,?,?)').run(providerMessageId, channel, 'sent', Date.now(), inboundId, Date.now())
  }

  private admitConversation(id: string, jid: string, content: string, timestamp: number, channel: string, payload: unknown): boolean {
    if (this.db.prepare('SELECT 1 FROM conversations WHERE jid = ?').get(jid)) return true
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number }).count
    if (count < MAX_ACTIVE_CONVERSATIONS) return true
    this.db.prepare('INSERT INTO inbound_events (id,jid,content,received_at,status,channel,payload) VALUES (?,?,?,?,?,?,?)').run(id, jid, content, timestamp, 'capacity_limited', channel, JSON.stringify(payload))
    this.audit('conversation_capacity_reached', { id, jid, cap: MAX_ACTIVE_CONVERSATIONS })
    this.notifyOwner('failure', { messageId: id, jid, error: 'Maximum active conversation limit reached' })
    this.publish()
    return false
  }

  private ensureChannelAccount(message: Pick<ChannelMessage, 'channel' | 'businessId' | 'channelAccountId' | 'to'>): void {
    const businessId = message.businessId || 'local-business'
    const accountId = message.channelAccountId || message.to
    if (!accountId) return
    const now = Date.now()
    this.db.prepare('INSERT INTO channel_accounts (business_id,channel,account_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(business_id,channel,account_id) DO UPDATE SET updated_at = excluded.updated_at').run(businessId, message.channel, accountId, 'connected', now, now)
  }

  usageHistory(days = 30): Array<{ day: string; llmCalls: number; outboundMessages: number; estimatedCost: number }> {
    const safeDays = Number.isInteger(days) && days > 0 && days <= 90 ? days : 30
    return this.db.prepare(`SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, SUM(CASE WHEN kind = 'llm' THEN amount ELSE 0 END) AS llmCalls, SUM(CASE WHEN kind = 'outbound' THEN amount ELSE 0 END) AS outboundMessages, COALESCE(SUM(estimated_cost), 0) AS estimatedCost FROM usage_events WHERE created_at >= ? GROUP BY day ORDER BY day DESC`).all(Date.now() - safeDays * 24 * 60 * 60 * 1000) as Array<{ day: string; llmCalls: number; outboundMessages: number; estimatedCost: number }>
  }

  async approveDraft(inboundId: string): Promise<SupervisorState> {
    const draft = this.db.prepare("SELECT d.jid, d.content, d.conversation_revision AS revision, d.expires_at AS expiresAt, e.received_at AS receivedAt FROM drafts d JOIN inbound_events e ON e.id = d.inbound_id WHERE d.inbound_id = ? AND d.status = 'pending'").get(inboundId) as { jid: string; content: string; revision: number; expiresAt: number; receivedAt: number } | undefined
    if (!draft || draft.expiresAt <= Date.now()) throw new Error('Draft is missing or expired')
    if (!isWithinWhatsAppServiceWindow(draft.receivedAt)) throw new Error('Draft is outside the WhatsApp service window; use an approved template')
    const current = (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(draft.jid) as { revision: number } | undefined)?.revision
    if (current !== draft.revision) {
      this.db.prepare("UPDATE drafts SET status = 'superseded' WHERE inbound_id = ?").run(inboundId)
      throw new Error('Draft is stale and was superseded')
    }
    if (this.state.paused || this.state.status === 'stopped') throw new Error('Supervisor must be running and unpaused')
    this.db.prepare("UPDATE drafts SET status = 'approved' WHERE inbound_id = ? AND status = 'pending'").run(inboundId)
    this.audit('approve_draft', { inboundId })
    await this.sendWithRetry({ id: inboundId, from: draft.jid, to: whatsappService.getConnectionState().phoneNumber || '', content: '', timestamp: Date.now(), type: 'text', isFromMe: false }, draft.content, draft.revision)
    return this.getState()
  }

  async sendApprovedTemplate(inboundId: string, name: string, languageCode: string, parameters: string[] = []): Promise<SupervisorState> {
    if (!this.db.prepare('SELECT 1 FROM approved_templates WHERE name = ? AND language_code = ? AND active = 1').get(name, languageCode)) throw new Error('Template is not active in the approved registry')
    if (this.outboundTransport.kind !== 'cloud') throw new Error('Approved templates require WhatsApp Cloud transport')
    if (parameters.length > 10 || parameters.some(value => value.length > 500)) throw new Error('Invalid template parameters')
    const inbound = this.db.prepare('SELECT e.jid, e.channel, e.received_at AS receivedAt FROM inbound_events e WHERE e.id = ?').get(inboundId) as { jid: string; channel: string; receivedAt: number } | undefined
    if (!inbound) throw new Error('Inbound message not found')
    if (inbound.channel !== 'whatsapp') throw new Error('Approved templates require a WhatsApp inbound conversation')
    if (!this.hasLease()) throw new Error('Supervisor lease is not held')
    if (isWithinWhatsAppServiceWindow(inbound.receivedAt)) throw new Error('Use free-form response inside the WhatsApp service window')
    if (this.state.paused || this.state.status === 'stopped' || this.pausedConversations.has(inbound.jid)) throw new Error('Supervisor is paused')
    if (this.db.prepare('SELECT 1 FROM consents WHERE jid = ? AND opted_out = 1').get(inbound.jid)) throw new Error('Customer has opted out')
    if (this.db.prepare('SELECT status FROM outbound_sends WHERE inbound_id = ?').get(inboundId)) return this.getState()
    if (this.usageCount('outbound') >= DAILY_OUTBOUND_CAP) throw new Error('Daily outbound message budget cap reached')
    const content = `[template:${name}:${languageCode}]`
    const payloadHash = createHash('sha256').update(JSON.stringify({ name, languageCode, parameters })).digest('hex')
    this.db.prepare('INSERT INTO outbound_sends (inbound_id,provider_message_id,jid,content,sent_at,status,error,payload_hash) VALUES (?,?,?,?,?,?,?,?)').run(inboundId, null, inbound.jid, content, Date.now(), 'sending', null, payloadHash)
    this.audit('send_approved_template', { inboundId, name, languageCode })
    const result = await this.outboundTransport.sendTemplate(inbound.jid, name, languageCode, parameters)
    if (!result.success) {
      this.db.prepare('UPDATE outbound_sends SET status = ?, error = ?, sent_at = ? WHERE inbound_id = ?').run('failed', result.error || 'template send failed', Date.now(), inboundId)
      this.notifyOwner('failure', { messageId: inboundId, error: result.error || 'template send failed' })
      throw new Error(result.error || 'Template send failed')
    }
    this.recordUsage('outbound', 0, 'whatsapp')
    this.db.prepare('UPDATE outbound_sends SET provider_message_id = ?, status = ?, sent_at = ? WHERE inbound_id = ?').run(result.providerMessageId ?? null, 'sent', Date.now(), inboundId)
    this.recordInitialDelivery(result.providerMessageId, 'whatsapp', inboundId)
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('sent', inboundId)
    return this.getState()
  }

  private startHealthMonitor(): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => this.checkHealth(), 30_000)
    this.checkHealth()
  }

  private checkHealth(): void {
    const channel = whatsappService.getConnectionState()
    this.state.lastHealthCheck = Date.now()
    this.expireDrafts()
    if (this.outboundTransport.kind === 'baileys' && channel.status === 'connected') this.baileysWasConnected = true
    if (this.outboundTransport.kind === 'baileys' && this.baileysWasConnected && this.state.status === 'running' && channel.status !== 'connected') {
      this.baileysDispatchBlocked = true
      this.state.status = 'degraded'
      // WhatsApp degradation must not pause unrelated email/Meta work.
      this.state.lastError = `WhatsApp channel is ${channel.status}`
      this.audit('channel_degraded', { status: channel.status })
    }
    if (this.state.status === 'running' && !this.renewLease()) { this.state.status = 'degraded'; this.state.paused = true; this.state.lastError = 'Supervisor lease lost' }
    if (Date.now() - this.lastRetentionAt >= 24 * 60 * 60 * 1000) { this.pruneRetention(); this.lastRetentionAt = Date.now() }
    if (this.outboundTransport.kind === 'baileys' && this.state.status === 'degraded' && channel.status === 'connected' && this.state.lastError?.startsWith('WhatsApp channel is')) {
      this.state.status = 'running'
      this.state.lastError = null
    }
    this.publish()
  }

  private expireDrafts(): void {
    const result = this.db.prepare("UPDATE drafts SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(Date.now())
    if (result.changes > 0) this.audit('expire_drafts', { count: result.changes })
  }

  private async drain(jid: string): Promise<void> {
    if (this.active.has(jid) || this.pausedConversations.has(jid) || this.baileysDispatchBlocked) return
    this.active.add(jid)
    try {
      while (!this.state.paused && this.queues.get(jid)?.length) {
        const message = this.queues.get(jid)!.shift()!
        this.state.activeJob = message.id; this.publish()
        await this.process(message)
        this.state.lastProcessedMessage = message.id; this.state.activeJob = null; this.publish()
      }
    } finally { this.active.delete(jid); this.publish() }
  }

  private async drainEmail(jid: string): Promise<void> {
    if (this.active.has(jid) || this.pausedConversations.has(jid)) return
    this.active.add(jid)
    try {
      while (!this.state.paused && this.emailQueues.get(jid)?.length) {
        const message = this.emailQueues.get(jid)!.shift()!
        this.state.activeJob = message.id; this.publish()
        await this.processEmail(message, jid)
        this.state.lastProcessedMessage = message.id; this.state.activeJob = null; this.publish()
      }
    } finally { this.active.delete(jid); this.publish() }
  }

  private async drainMeta(jid: string): Promise<void> {
    if (this.active.has(jid) || this.pausedConversations.has(jid)) return
    this.active.add(jid)
    try {
      while (!this.state.paused && this.metaQueues.get(jid)?.length) {
        const message = this.metaQueues.get(jid)!.shift()!
        this.state.activeJob = message.id; this.publish()
        await this.processExternal(message, jid, async body => message.channel === 'twitter' ? (this.xTransport ? this.xTransport.sendText(message.from, body) : { success: false, error: 'X transport is not configured' }) : (this.metaTransport ? this.metaTransport.sendText(message.from, body) : { success: false, error: 'Meta transport is not configured' }))
        this.state.lastProcessedMessage = message.id; this.state.activeJob = null; this.publish()
      }
    } finally { this.active.delete(jid); this.publish() }
  }

  private async processEmail(message: ChannelMessage, jid: string): Promise<void> {
    await this.processExternal(message, jid, async body => emailChannelService.send({ to: message.to, subject: message.subject ? `Re: ${message.subject}` : 'Customer support response', body, inReplyTo: message.messageId, references: message.references }))
  }

  private async runDecision(message: WorkflowMessage): Promise<ResponseDecision> {
    const runId = randomUUID()
    const threadId = workflowThreadId(message)
    const startedAt = Date.now()
    this.db.prepare('INSERT INTO graph_runs (id,inbound_id,thread_id,status,started_at,finished_at,graph_version,prompt_version,policy_version,error) VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(runId, message.id, threadId, 'running', startedAt, null, GRAPH_VERSION, PROMPT_VERSION, POLICY_VERSION)
    try {
      const decision = await runAutonomyWorkflow(this.workflow, message)
      this.db.prepare('UPDATE graph_runs SET status = ?, finished_at = ? WHERE id = ?').run('completed', Date.now(), runId)
      return decision
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      this.db.prepare('UPDATE graph_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run('failed', Date.now(), failure, runId)
      throw error
    }
  }

  private async processExternal(message: ChannelMessage, jid: string, send: (body: string) => Promise<{ success: boolean; providerMessageId?: string; error?: string }>): Promise<void> {
    if (this.state.mode === 'observe') {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('observed', message.id); return
    }
    const capabilities = getChannelCapabilities(message.channel)
    const requiresHumanReview = message.type !== 'text' || Boolean(message.mediaUrl || message.mediaId || message.attachments?.length)
    let decision: ResponseDecision = requiresHumanReview
      ? { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'media_requires_human_review' }
      : await this.runDecision(message)
    if (decision.text && decision.text.length > capabilities.maxTextLength) decision = { ...decision, text: null, escalated: true, reason: 'channel_text_limit' }
    const revision = this.messageRevisions.get(message.id) ?? 0
    const currentRevision = (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(jid) as { revision: number } | undefined)?.revision ?? revision
    const withinResponseWindow = capabilities.responseWindowMs === null || Date.now() - message.timestamp <= capabilities.responseWindowMs
    const policy = evaluateAutonomyPolicy({ mode: this.state.mode, responsePermission: this.state.responsePermission, optedOut: Boolean(this.db.prepare('SELECT 1 FROM consents WHERE jid = ? AND opted_out = 1').get(jid)), withinResponseWindow, staleRevision: isStaleRevision(revision, currentRevision), decision })
    if (policy.disposition === 'escalate') decision = { ...decision, text: null, escalated: true, reason: policy.reason }
    this.db.prepare('INSERT OR REPLACE INTO decisions (inbound_id,jid,decision,created_at,conversation_revision,graph_version,prompt_version,policy_version) VALUES (?,?,?,?,?,?,?,?)').run(message.id, jid, JSON.stringify(decision), Date.now(), revision, GRAPH_VERSION, PROMPT_VERSION, POLICY_VERSION)
    if (policy.disposition !== 'send') {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run(decision.escalated ? 'escalated' : 'draft', message.id)
      if (policy.disposition === 'draft' && decision.text) this.db.prepare("INSERT OR REPLACE INTO drafts (inbound_id,jid,content,content_hash,conversation_revision,status,expires_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)").run(message.id, jid, decision.text, draftContentHash(decision.text), revision, Date.now() + 24 * 60 * 60 * 1000, Date.now())
      if (decision.escalated) { this.state.escalations++; this.notifyOwner('escalation', { inboundId: message.id, jid, reason: decision.reason }) }
      this.emit('decision', { message, decision }); this.publish(); return
    }
    if (!this.hasLease() || this.state.paused) { this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('queued', message.id); return }
    const body = `Hi — I’m the AI support assistant for ${BusinessPersona.getInstance().getProfile().name}.\n\n${decision.text!}`
    if (message.channel === 'twitter') {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM outbound_sends WHERE jid = ? AND sent_at >= ? AND status IN ('sent','sending','delivery-unknown')").get(jid, cutoff) as { count: number }).count
      if (count >= 5) {
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('escalated', message.id)
        this.notifyOwner('escalation', { inboundId: message.id, jid, reason: 'x_response_window_limit' })
        return
      }
    }
    const payloadHash = createHash('sha256').update(JSON.stringify({ to: message.to, subject: message.subject, body, inReplyTo: message.messageId, references: message.references })).digest('hex')
    if (this.db.prepare('SELECT status FROM outbound_sends WHERE inbound_id = ?').get(message.id)) return
    this.db.prepare('INSERT INTO outbound_sends (inbound_id,provider_message_id,jid,content,sent_at,status,error,payload_hash) VALUES (?,?,?,?,?,?,?,?)').run(message.id, null, jid, body, Date.now(), 'sending', null, payloadHash)
    const result = await send(body)
    if (!result.success) {
      const error = result.error || 'email send failed'
      this.db.prepare('UPDATE outbound_sends SET status = ?, error = ?, sent_at = ? WHERE inbound_id = ?').run(isAmbiguousSendError(error) ? 'delivery-unknown' : 'failed', error, Date.now(), message.id)
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run(isAmbiguousSendError(error) ? 'delivery_unknown' : 'failed', message.id)
      this.notifyOwner('failure', { messageId: message.id, error }); return
    }
    this.recordUsage('outbound', 0, message.channel)
    this.db.prepare('UPDATE outbound_sends SET provider_message_id = ?, status = ?, sent_at = ? WHERE inbound_id = ?').run(result.providerMessageId ?? null, 'sent', Date.now(), message.id)
    this.recordInitialDelivery(result.providerMessageId, message.channel, message.id)
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('sent', message.id)
  }

  private async process(message: WhatsAppMessage): Promise<void> {
    if (isOptOutMessage(message.content)) {
      this.db.prepare(`
        INSERT INTO consents (jid, opted_out, source, updated_at) VALUES (?, 1, 'customer_message', ?)
        ON CONFLICT(jid) DO UPDATE SET opted_out = 1, source = excluded.source, updated_at = excluded.updated_at
      `).run(message.from, Date.now())
    }
    if (this.state.mode === 'observe') {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('observed', message.id); return
    }
    let decision = await this.runDecision(message)
    const revision = this.messageRevisions.get(message.id) ?? 0
    const currentRevision = (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(message.from) as { revision: number } | undefined)?.revision ?? revision
    const policy = evaluateAutonomyPolicy({
      mode: this.state.mode,
      responsePermission: this.state.responsePermission,
      optedOut: Boolean(this.db.prepare('SELECT 1 FROM consents WHERE jid = ? AND opted_out = 1').get(message.from)),
      withinResponseWindow: isWithinWhatsAppServiceWindow(message.timestamp),
      staleRevision: isStaleRevision(revision, currentRevision),
      decision
    })
    if (policy.disposition === 'escalate') decision = { ...decision, text: null, escalated: true, reason: policy.reason }
    this.db.prepare(`
      INSERT OR REPLACE INTO decisions
        (inbound_id,jid,decision,created_at,conversation_revision,graph_version,prompt_version,policy_version)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(message.id, message.from, JSON.stringify(decision), Date.now(), revision, GRAPH_VERSION, PROMPT_VERSION, POLICY_VERSION)
    if (policy.disposition !== 'send') {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run(decision.escalated ? 'escalated' : 'draft', message.id)
      if (policy.disposition === 'draft' && decision.text) {
        this.db.prepare(`INSERT OR REPLACE INTO drafts (inbound_id,jid,content,content_hash,conversation_revision,status,expires_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)`)
          .run(message.id, message.from, decision.text, draftContentHash(decision.text), revision, Date.now() + 24 * 60 * 60 * 1000, Date.now())
      }
      if (decision.escalated) { this.state.escalations++; this.notifyOwner('escalation', { inboundId: message.id, jid: message.from, reason: decision.reason }) }
      this.emit('decision', { message, decision }); this.publish(); return
    }
    await this.sendWithRetry(message, decision.text!, revision)
  }

  private async decide(message: WhatsAppMessage): Promise<ResponseDecision> {
    const content = message.content.trim()
    if (message.type !== 'text') return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'media_requires_human_review' }
    if (isOptInMessage(content)) return { text: 'You are subscribed to customer support messages again.', confidence: 1, grounding: 'grounded', escalated: false, sensitiveTopic: false, reason: 'opt_in' }
    if (isOptOutMessage(content)) return { text: 'Understood — we will not send further automated replies.', confidence: 1, grounding: 'grounded', escalated: false, sensitiveTopic: false, reason: 'opt_out' }
    if (isPromptInjection(content)) return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'prompt_injection_requires_human' }
    const sensitiveTopic = isSensitiveSupportTopic(content)
    if (sensitiveTopic) return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: true, reason: 'sensitive_topic_requires_human' }
    if (isAccountSpecificRequest(content)) return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'account_specific_requires_human' }
    if (!isAllowlistedSupportIntent(content)) return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'intent_not_allowlisted' }
    if (!this.gemini) return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'no_approved_llm_configured' }
    if (this.usageCount('llm') >= DAILY_LLM_CAP) return { text: null, confidence: 0, grounding: 'unavailable', escalated: true, sensitiveTopic: false, reason: 'daily_llm_budget_cap' }
    const chunks = await RAGEngine.getInstance().search(content, 4)
    if (!chunks.length) return { text: null, confidence: 0, grounding: 'not_grounded', escalated: true, sensitiveTopic: false, reason: 'no_knowledge_match' }
    const persona = BusinessPersona.getInstance()
    let memoryContext = ''
    let memoryEvidence: Array<{ id: string; name: string; type: string }> = []
    try {
      const memories = await MemoryService.getInstance().search(content, 3, { workspace: 'business-support', project: 'autonomous-agent' })
      memoryContext = memories.map(memory => `[memory:${memory.type}] ${memory.name}: ${memory.description.slice(0, 600)}`).join('\n')
      memoryEvidence = memories.map(memory => ({ id: memory.id, name: memory.name, type: memory.type }))
    } catch (error) {
      console.warn('[Autonomy] Scoped memory unavailable; continuing with RAG only', error instanceof Error ? error.message : String(error))
    }
    const context = [memoryContext, chunks.map(c => `[${c.file_name}] ${c.content.slice(0, 1800)}`).join('\n')].filter(Boolean).join('\n')
    const controller = new AbortController()
    this.generationControllers.set(message.id, { jid: message.from, controller })
    const timer = setTimeout(() => controller.abort(), 25_000)
    let raw: string
    try {
      raw = await this.gemini.generateText(
        `${persona.getSystemPrompt()}\nAnswer only from the supplied business context. Return JSON only with keys text, confidence (0..1), and grounding (grounded|not_grounded). If the context does not answer the question, set text to an empty string and grounding to not_grounded.`,
        `Customer: ${content}\nBusiness context:\n${context}`,
        { maxOutputTokens: 512, signal: controller.signal }
      )
    } finally {
      clearTimeout(timer)
      this.generationControllers.delete(message.id)
    }
    this.recordUsage('llm', Math.ceil((content.length + raw.length) / 4))
    const parsed = parseAutonomyDecision(raw)
    const evidence = chunks.map(chunk => ({ fileName: chunk.file_name, filePath: chunk.file_path, rank: chunk.rank }))
    if (!parsed || parsed.grounding !== 'grounded' || parsed.confidence < 0.8) {
      return { text: null, confidence: parsed?.confidence ?? 0, grounding: parsed?.grounding ?? 'unavailable', escalated: true, sensitiveTopic: false, reason: 'model_output_failed_validation', evidence, memoryEvidence }
    }
    return { ...parsed, escalated: false, sensitiveTopic: false, reason: 'rag_grounded_answer', evidence, memoryEvidence }
  }

  private restoreQueuedMessages(): void {
    const rows = this.db.prepare(`
      SELECT e.id, e.jid, e.content, e.received_at AS timestamp, e.channel, e.payload, c.revision
      FROM inbound_events e LEFT JOIN conversations c ON c.jid = e.jid
      WHERE status IN ('queued', 'processing', 'retrying')
      ORDER BY received_at ASC
    `).all() as Array<{ id: string; jid: string; content: string; timestamp: number; channel: string; payload: string | null; revision: number | null }>
    for (const row of rows) {
      let message: ChannelMessage | WhatsAppMessage
      try { message = row.payload ? JSON.parse(row.payload) as ChannelMessage : { id: row.id, from: row.jid, to: whatsappService.getConnectionState().phoneNumber || '', content: row.content || '', timestamp: row.timestamp, type: 'text', isFromMe: false } } catch { message = { id: row.id, from: row.jid, to: whatsappService.getConnectionState().phoneNumber || '', content: row.content || '', timestamp: row.timestamp, type: 'text', isFromMe: false } }
      if (row.channel === 'email') { const queue = this.emailQueues.get(row.jid) ?? []; queue.push(message as ChannelMessage); this.emailQueues.set(row.jid, queue) }
      else if (row.channel === 'instagram' || row.channel === 'messenger' || row.channel === 'twitter') { const queue = this.metaQueues.get(row.jid) ?? []; queue.push(message as ChannelMessage); this.metaQueues.set(row.jid, queue) }
      else { const queue = this.queues.get(row.jid) ?? []; queue.push(message as WhatsAppMessage); this.queues.set(row.jid, queue) }
      this.messageRevisions.set(row.id, row.revision ?? 0)
    }
  }

  private async sendWithRetry(message: WhatsAppMessage, text: string, expectedRevision: number): Promise<void> {
    if (!this.hasLease()) { this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('queued', message.id); return }
    const channelStatus = whatsappService.getConnectionState().status
    if (this.outboundTransport.kind === 'baileys' && channelStatus !== 'connected') {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('queued', message.id)
      const queue = this.queues.get(message.from) ?? []
      queue.unshift(message); this.queues.set(message.from, queue)
      this.state.status = 'degraded'; this.state.lastError = `WhatsApp channel is ${channelStatus}`; this.audit('whatsapp_send_blocked_channel', { inboundId: message.id }); this.publish()
      return
    }
    const already = this.db.prepare('SELECT status FROM outbound_sends WHERE inbound_id = ?').get(message.id) as { status: string } | undefined
    if (already) return
    if (this.usageCount('outbound') >= DAILY_OUTBOUND_CAP) {
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('failed', message.id)
      this.state.lastError = 'Daily outbound message budget cap reached'; this.state.status = 'degraded'; this.notifyOwner('budget', { messageId: message.id, cap: DAILY_OUTBOUND_CAP }); this.publish()
      return
    }
    const body = `Hi — I’m the AI support assistant for ${BusinessPersona.getInstance().getProfile().name}.\n\n${text}`
    const payloadHash = createHash('sha256').update(body).digest('hex')
    // Claim before calling the provider. A crash after provider acceptance must not replay automatically.
    this.db.prepare('INSERT INTO outbound_sends (inbound_id,provider_message_id,jid,content,sent_at,status,error,payload_hash) VALUES (?,?,?,?,?,?,?,?)').run(message.id, null, message.from, body, Date.now(), 'pending', null, payloadHash)
    this.db.prepare('UPDATE outbound_sends SET status = ? WHERE inbound_id = ?').run('authorized', message.id)
    this.db.prepare('UPDATE outbound_sends SET status = ? WHERE inbound_id = ?').run('sending', message.id)
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('processing', message.id)
    let error = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const currentRevision = (this.db.prepare('SELECT revision FROM conversations WHERE jid = ?').get(message.from) as { revision: number } | undefined)?.revision
      if (isStaleRevision(expectedRevision, currentRevision ?? -1)) {
        this.db.prepare('DELETE FROM outbound_sends WHERE inbound_id = ?').run(message.id)
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('superseded', message.id)
        return
      }
      if (this.state.paused || this.pausedConversations.has(message.from)) {
        this.db.prepare('DELETE FROM outbound_sends WHERE inbound_id = ?').run(message.id)
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('queued', message.id)
        const queue = this.queues.get(message.from) ?? []
        queue.unshift(message); this.queues.set(message.from, queue)
        return
      }
      if (!this.hasLease()) {
        this.db.prepare('DELETE FROM outbound_sends WHERE inbound_id = ?').run(message.id)
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('queued', message.id)
        const queue = this.queues.get(message.from) ?? []
        queue.unshift(message); this.queues.set(message.from, queue)
        return
      }
      if (!isDispatchAllowed(this.state.mode, this.state.responsePermission, this.state.paused, this.pausedConversations.has(message.from))) {
        this.db.prepare('DELETE FROM outbound_sends WHERE inbound_id = ?').run(message.id)
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('draft', message.id)
        this.db.prepare(`INSERT OR REPLACE INTO drafts (inbound_id,jid,content,content_hash,conversation_revision,status,expires_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)`)
          .run(message.id, message.from, body, draftContentHash(body), expectedRevision, Date.now() + 24 * 60 * 60 * 1000, Date.now())
        this.audit('send_blocked_permission_revoked', { inboundId: message.id })
        return
      }
      const result = await this.outboundTransport.sendText(message.from, body)
      if (result.success) {
        this.recordUsage('outbound', 0, 'whatsapp')
        this.db.prepare('UPDATE outbound_sends SET provider_message_id = ?, sent_at = ?, status = ?, error = ? WHERE inbound_id = ?').run(result.providerMessageId ?? null, Date.now(), 'sent', null, message.id)
        this.recordInitialDelivery(result.providerMessageId, 'whatsapp', message.id)
        this.db.prepare('INSERT OR IGNORE INTO conversation_messages (id,jid,role,content,timestamp) VALUES (?,?,?,?,?)').run(`out:${message.id}`, message.from, 'assistant', body, Date.now())
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('sent', message.id); return
      }
      error = result.error || 'send failed'
      const errorClass = classifyProviderError(error)
      if (isAmbiguousSendError(error) || !isConfirmedPreSendTransientError(error)) {
        this.db.prepare('UPDATE outbound_sends SET sent_at = ?, status = ?, error = ? WHERE inbound_id = ?').run(Date.now(), 'delivery-unknown', error, message.id)
        this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('delivery_unknown', message.id)
        this.state.lastDeliveryStatus = 'delivery-unknown'; this.state.lastDeliveryInboundId = message.id
        this.state.lastError = error; this.state.status = 'degraded'; this.notifyOwner('failure', { messageId: message.id, error }); this.emit('failure', { messageId: message.id, error }); this.publish()
        return
      }
      if (errorClass === 'auth' || errorClass === 'permission' || errorClass === 'permanent') break
      this.db.prepare('INSERT INTO retries (inbound_id,attempt,error,next_at) VALUES (?,?,?,?)').run(message.id, attempt + 1, error, Date.now() + (2 ** attempt) * 1000)
      this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('retrying', message.id)
      await new Promise(resolve => setTimeout(resolve, (2 ** attempt) * 1000))
    }
    this.db.prepare('UPDATE outbound_sends SET sent_at = ?, status = ?, error = ? WHERE inbound_id = ?').run(Date.now(), 'failed', error, message.id)
    this.db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run('failed', message.id)
    this.state.lastError = error; this.state.status = 'degraded'; this.notifyOwner('failure', { messageId: message.id, error }); this.emit('failure', { messageId: message.id, error }); this.publish()
  }

  private acquireLease(): boolean {
    const now = Date.now()
    const current = this.db.prepare('SELECT owner, generation, heartbeat_at AS heartbeatAt FROM supervisor_lease WHERE id = 1').get() as { owner: string; generation: number; heartbeatAt: number } | undefined
    if (current && current.owner !== this.leaseOwner && now - current.heartbeatAt < LEASE_TTL_MS) {
      this.state.status = 'degraded'; this.state.paused = true; this.state.lastError = 'Another supervisor instance owns the lease'; this.notifyOwner('failure', { error: this.state.lastError }); return false
    }
    this.leaseGeneration = (current?.generation ?? 0) + 1
    this.db.prepare('INSERT INTO supervisor_lease (id,owner,generation,heartbeat_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, generation = excluded.generation, heartbeat_at = excluded.heartbeat_at').run(this.leaseOwner, this.leaseGeneration, now)
    return true
  }

  private renewLease(): boolean {
    const result = this.db.prepare('UPDATE supervisor_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ? AND generation = ?').run(Date.now(), this.leaseOwner, this.leaseGeneration)
    return result.changes === 1
  }

  private hasLease(): boolean {
    const row = this.db.prepare('SELECT heartbeat_at AS heartbeatAt FROM supervisor_lease WHERE id = 1 AND owner = ? AND generation = ?').get(this.leaseOwner, this.leaseGeneration) as { heartbeatAt: number } | undefined
    return Boolean(row && Date.now() - row.heartbeatAt < LEASE_TTL_MS)
  }

  registerIpc(): void {
    ipcMain.handle('autonomy:get-state', () => this.getState())
    ipcMain.handle('autonomy:get-health', () => this.getHealth())
    ipcMain.handle('autonomy:get-metrics', (_e: unknown, days: unknown) => this.getMetrics(Number(days)))
    ipcMain.handle('autonomy:reconnect-channel', () => this.reconnectChannel())
    ipcMain.handle('autonomy:start', () => this.start())
    ipcMain.handle('autonomy:stop', () => this.stop())
    ipcMain.handle('autonomy:pause', (_e: unknown, emergency = false) => this.pause(Boolean(emergency)))
    ipcMain.handle('autonomy:resume', () => this.resume())
    ipcMain.handle('autonomy:enter-recovery-mode', (_e: unknown, reason: unknown) => this.enterRecoveryMode(typeof reason === 'string' && reason ? reason : undefined))
    ipcMain.handle('autonomy:clear-recovery-mode', () => this.clearRecoveryMode())
    ipcMain.handle('autonomy:stage-backup', (_e: unknown, backupPath: unknown) => this.stageBackup(String(backupPath)))
    ipcMain.handle('autonomy:prune-retention', () => this.pruneRetentionNow())
    ipcMain.handle('autonomy:pause-conversation', (_e: unknown, jid: unknown) => this.pauseConversation(String(jid)))
    ipcMain.handle('autonomy:resume-conversation', (_e: unknown, jid: unknown) => this.resumeConversation(String(jid)))
    ipcMain.handle('autonomy:retry-delivery', (_e: unknown, inboundId: unknown) => this.retryDelivery(String(inboundId)))
    ipcMain.handle('autonomy:quarantine-delivery', (_e: unknown, inboundId: unknown) => this.quarantineDelivery(String(inboundId)))
    ipcMain.handle('autonomy:cancel-outbound', (_e: unknown, inboundId: unknown) => this.cancelOutbound(String(inboundId)))
    ipcMain.handle('autonomy:list-approved-templates', () => this.listApprovedTemplates())
    ipcMain.handle('autonomy:list-takeovers', () => this.listTakeovers())
    ipcMain.handle('autonomy:list-drafts', () => this.listDrafts())
    ipcMain.handle('autonomy:list-unresolved-outbound', () => this.listUnresolvedOutbound())
    ipcMain.handle('autonomy:list-delivery-history', (_e: unknown, limit: unknown) => this.listDeliveryHistory(Number(limit)))
    ipcMain.handle('autonomy:list-decision-evidence', (_e: unknown, limit: unknown) => this.listDecisionEvidence(Number(limit)))
    ipcMain.handle('autonomy:review-decision', (_e: unknown, inboundId: unknown, label: unknown, notes: unknown) => this.reviewDecision(String(inboundId), String(label) as QualityReviewLabel, typeof notes === 'string' ? notes : ''))
    ipcMain.handle('autonomy:usage-history', (_e: unknown, days: unknown) => this.usageHistory(Number(days)))
    ipcMain.handle('autonomy:channel-usage', (_e: unknown, days: unknown) => this.getChannelUsage(Number(days)))
    ipcMain.handle('autonomy:approve-draft', (_e: unknown, inboundId: unknown) => this.approveDraft(String(inboundId)))
    ipcMain.handle('autonomy:send-approved-template', (_e: unknown, inboundId: unknown, name: unknown, languageCode: unknown, parameters: unknown) => this.sendApprovedTemplate(String(inboundId), String(name), String(languageCode), Array.isArray(parameters) ? parameters.map(String) : []))
    ipcMain.handle('autonomy:register-approved-template', (_e: unknown, name: unknown, languageCode: unknown, category: unknown) => this.registerApprovedTemplate(String(name), String(languageCode), String(category)))
    ipcMain.handle('autonomy:revoke-approved-template', (_e: unknown, name: unknown, languageCode: unknown) => this.revokeApprovedTemplate(String(name), String(languageCode)))
    ipcMain.handle('autonomy:set-mode', (_e: unknown, mode: unknown, permission: unknown) => {
      if (!['observe', 'draft', 'auto'].includes(String(mode))) throw new Error('Invalid autonomy mode')
      return this.setMode(mode as AutonomyMode, Boolean(permission))
    })
    this.on('decision', data => this.broadcast('autonomy:decision', data))
    this.on('failure', data => this.broadcast('autonomy:failure', data))
    ipcMain.handle('autonomy:list-notifications', () => this.db.prepare("SELECT id, kind, details, status, created_at AS createdAt FROM notifications WHERE status = 'unread' ORDER BY created_at DESC LIMIT 50").all())
    ipcMain.handle('autonomy:ack-notification', (_e: unknown, id: unknown) => this.db.prepare("UPDATE notifications SET status = 'read' WHERE id = ?").run(Number(id)))
  }

  private audit(action: string, details?: unknown): void {
    this.db.prepare('INSERT INTO operator_actions (action,details,created_at) VALUES (?,?,?)').run(action, details ? JSON.stringify(details) : null, Date.now())
    fs.writeFileSync(this.storePath, JSON.stringify(this.state))
  }
  private notifyOwner(kind: string, details: unknown): void {
    const payload = { kind, details, createdAt: Date.now() }
    this.db.prepare('INSERT INTO notifications (kind,details,created_at) VALUES (?,?,?)').run(kind, JSON.stringify(details), payload.createdAt)
    this.broadcast('autonomy:notification', payload)
  }
  private usageCount(kind: string): number {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    return (this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE kind = ? AND created_at >= ?').get(kind, start.getTime()) as { total: number }).total
  }
  pruneRetentionNow(): SupervisorState {
    this.pruneRetention()
    this.audit('retention_prune_manual')
    this.publish()
    return this.getState()
  }

  private pruneRetention(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const removed = this.db.transaction(() => {
      const counts = [
        this.db.prepare('DELETE FROM conversation_messages WHERE timestamp < ?').run(cutoff).changes,
        this.db.prepare("DELETE FROM inbound_events WHERE received_at < ? AND status NOT IN ('queued','processing','retrying')").run(cutoff).changes,
        this.db.prepare('DELETE FROM decisions WHERE created_at < ?').run(cutoff).changes,
        this.db.prepare('DELETE FROM retries WHERE next_at < ?').run(cutoff).changes,
        this.db.prepare("DELETE FROM drafts WHERE created_at < ? AND status <> 'pending'").run(cutoff).changes,
        this.db.prepare("DELETE FROM outbound_sends WHERE sent_at < ? AND status IN ('sent','failed','quarantined','cancelled')").run(cutoff).changes,
        this.db.prepare('DELETE FROM delivery_events WHERE created_at < ?').run(cutoff).changes,
        this.db.prepare("DELETE FROM notifications WHERE created_at < ? AND status = 'read'").run(cutoff).changes,
        this.db.prepare('DELETE FROM usage_events WHERE created_at < ?').run(cutoff).changes,
        this.db.prepare('DELETE FROM operator_actions WHERE created_at < ?').run(cutoff).changes,
        this.db.prepare('DELETE FROM quality_reviews WHERE reviewed_at < ?').run(cutoff).changes,
        this.db.prepare('DELETE FROM takeovers WHERE active = 0 AND ended_at IS NOT NULL AND ended_at < ?').run(cutoff).changes
      ]
      return counts.reduce((total, count) => total + count, 0)
    })()
    if (removed > 0) this.audit('retention_prune', { removed, retentionDays: RETENTION_DAYS })
  }
  private recordUsage(kind: string, estimatedTokens = 0, channel?: string): void { this.db.prepare('INSERT INTO usage_events (kind,amount,estimated_tokens,estimated_cost,channel,created_at) VALUES (?,1,?,?,?,?)').run(kind, estimatedTokens, kind === 'llm' ? estimatedTokens / 1000 * COST_PER_1K_TOKENS : 0, channel ?? null, Date.now()) }
  private usageCost(): number { const start = new Date(); start.setHours(0, 0, 0, 0); return (this.db.prepare('SELECT COALESCE(SUM(estimated_cost), 0) AS total FROM usage_events WHERE created_at >= ?').get(start.getTime()) as { total: number }).total }
  private publish(): void { this.emit('state', this.getState()); this.broadcast('autonomy:state', this.getState()); fs.writeFileSync(this.storePath, JSON.stringify(this.state)) }
  private broadcast(channel: string, data: unknown): void { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, data) }
}

export const autonomousSupervisor = AutonomousSupervisor.getInstance()
