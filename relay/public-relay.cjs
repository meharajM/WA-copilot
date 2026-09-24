const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const Database = require('better-sqlite3')

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_LEASE_MS = 5 * 60 * 1000
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024
const MAX_LIMIT = 100

function safeSegment(value, label) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function normaliseSecret(value, label) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512) {
    throw new Error(`${label} must be 32-512 characters`)
  }
  return value
}

function timingSafeHex(expected, supplied) {
  const value = String(supplied || '').replace(/^sha256=/i, '').trim()
  if (!/^[a-f0-9]{64}$/i.test(value)) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'))
}

function bodyEventId(payload) {
  const candidates = [payload?.event_id, payload?.eventId, payload?.message_id, payload?.messageId, payload?.id]
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512) return candidate
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : []
      for (const message of messages) if (typeof message?.id === 'string' && message.id.length > 0 && message.id.length <= 512) return message.id
    }
  }
  return null
}

function bodyAccountId(payload) {
  const candidates = [payload?.account_id, payload?.accountId, payload?.business_account_id, payload?.metadata?.display_phone_number, payload?.account?.id]
  return candidates.find(value => typeof value === 'string' && value.length > 0 && value.length <= 256) || null
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function text(res, status, value) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(value) })
  res.end(value)
}

class PublicRelay {
  constructor({ dbPath, businessSecrets, ttlMs = DEFAULT_TTL_MS, leaseMs = DEFAULT_LEASE_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, clock = () => Date.now(), requireTls = false, tlsKey, tlsCert, logger = { warn() {}, error() {} } }) {
    if (!dbPath) throw new Error('dbPath is required')
    if (!businessSecrets || typeof businessSecrets !== 'object') throw new Error('businessSecrets is required')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive')
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive')
    this.dbPath = dbPath
    this.businessSecrets = new Map()
    for (const [key, value] of Object.entries(businessSecrets)) {
      const [businessId, provider] = key.split(':')
      safeSegment(businessId, 'business id')
      safeSegment(provider, 'provider')
      this.businessSecrets.set(key, {
        providerSecret: normaliseSecret(value.providerSecret, 'providerSecret'),
        agentSecret: normaliseSecret(value.agentSecret, 'agentSecret'),
      })
    }
    this.ttlMs = ttlMs
    this.leaseMs = leaseMs
    this.maxBodyBytes = maxBodyBytes
    this.clock = clock
    this.requireTls = requireTls
    this.tlsKey = tlsKey
    this.tlsCert = tlsCert
    this.logger = logger
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        body BLOB,
        content_type TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'acknowledged', 'expired')),
        lease_token TEXT,
        lease_expires_at INTEGER,
        acknowledged_at INTEGER,
        local_commit_id TEXT,
        UNIQUE (business_id, provider, account_id, provider_event_id)
      );
      CREATE INDEX IF NOT EXISTS relay_events_poll_idx ON relay_events (business_id, status, id);
      CREATE INDEX IF NOT EXISTS relay_events_expiry_idx ON relay_events (expires_at, status);
    `)
    this.server = null
  }

  secretFor(businessId, provider) {
    return this.businessSecrets.get(`${businessId}:${provider}`) || null
  }

  sweep(now = this.clock()) {
    const requeueExpiredLeases = this.db.prepare(`
      UPDATE relay_events
      SET status = 'pending', lease_token = NULL, lease_expires_at = NULL
      WHERE status = 'leased' AND lease_expires_at <= @now AND expires_at > @now
    `)
    const expireEvents = this.db.prepare(`
      UPDATE relay_events
      SET status = 'expired', body = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE status IN ('pending', 'leased') AND expires_at <= @now
    `)
    return this.db.transaction(() => (
      requeueExpiredLeases.run({ now }).changes + expireEvents.run({ now }).changes
    ))()
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0)
      if (declared > this.maxBodyBytes) {
        req.resume()
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        return
      }
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > this.maxBodyBytes) {
          req.destroy()
          reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  authAgent(req, credentials) {
    const value = String(req.headers.authorization || '')
    return value === `Bearer ${credentials.agentSecret}`
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://relay.invalid')
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, tls: Boolean(this.tlsKey && this.tlsCert), now: this.clock() })
    }
    const webhook = url.pathname.match(/^\/v1\/webhooks\/([^/]+)\/([^/]+)$/)
    if (req.method === 'POST' && webhook) return this.ingest(req, res, webhook[1], webhook[2])
    const poll = url.pathname.match(/^\/v1\/agents\/([^/]+)\/events$/)
    if (req.method === 'GET' && poll) return this.poll(req, res, poll[1], url.searchParams)
    const ack = url.pathname.match(/^\/v1\/agents\/([^/]+)\/events\/(\d+)\/ack$/)
    if (req.method === 'POST' && ack) return this.ack(req, res, ack[1], Number(ack[2]))
    return text(res, 404, 'Not found')
  }

  async ingest(req, res, businessId, provider) {
    let credentials
    try { safeSegment(businessId, 'business id'); safeSegment(provider, 'provider'); credentials = this.secretFor(businessId, provider) } catch (error) { return text(res, 400, error.message) }
    if (!credentials) return text(res, 404, 'Webhook route not configured')
    let body
    try { body = await this.readBody(req) } catch (error) { return text(res, error.statusCode || 400, error.message) }
    const expected = crypto.createHmac('sha256', credentials.providerSecret).update(body).digest('hex')
    const signature = req.headers['x-hub-signature-256'] || req.headers['x-aica-signature']
    if (!timingSafeHex(expected, signature)) return text(res, 401, 'Invalid signature')
    let payload
    try { payload = JSON.parse(body.toString('utf8')) } catch { return text(res, 400, 'JSON body required') }
    const eventId = String(req.headers['x-provider-event-id'] || bodyEventId(payload) || '')
    const accountId = String(req.headers['x-provider-account-id'] || bodyAccountId(payload) || '')
    if (!eventId || eventId.length > 512 || !accountId || accountId.length > 256) return text(res, 400, 'Provider event and account identity required')
    const now = this.clock()
    this.sweep(now)
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO relay_events (business_id, provider, account_id, provider_event_id, body, content_type, received_at, expires_at, status)
      VALUES (@businessId, @provider, @accountId, @eventId, @body, @contentType, @now, @expiresAt, 'pending')
    `).run({ businessId, provider, accountId, eventId, body, contentType: String(req.headers['content-type'] || 'application/json').slice(0, 128), now, expiresAt: now + this.ttlMs })
    const row = this.db.prepare('SELECT id FROM relay_events WHERE business_id = ? AND provider = ? AND account_id = ? AND provider_event_id = ?').get(businessId, provider, accountId, eventId)
    return json(res, 202, { accepted: true, duplicate: insert.changes === 0, eventId, id: row.id })
  }

  poll(req, res, businessId, searchParams) {
    let credentials
    try { safeSegment(businessId, 'business id') } catch (error) { return text(res, 400, error.message) }
    const provider = searchParams.get('provider') || null
    const configured = provider ? this.secretFor(businessId, provider) : [...this.businessSecrets.entries()].find(([key]) => key.startsWith(`${businessId}:`))?.[1]
    if (!configured || !this.authAgent(req, configured)) return text(res, 401, 'Agent authentication required')
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(searchParams.get('limit') || 20)))
    const afterId = Math.max(0, Number(searchParams.get('after') || 0))
    const now = this.clock()
    this.sweep(now)
    const leaseToken = crypto.randomBytes(24).toString('base64url')
    const rows = this.db.transaction(() => {
      const pending = this.db.prepare(`SELECT id, provider, account_id, provider_event_id, body, content_type, received_at, expires_at FROM relay_events WHERE business_id = ? AND status = 'pending' AND id > ? AND expires_at > ? ORDER BY id LIMIT ?`).all(businessId, afterId, now, limit)
      if (pending.length > 0) this.db.prepare(`UPDATE relay_events SET status = 'leased', lease_token = ?, lease_expires_at = ? WHERE id IN (${pending.map(() => '?').join(',')})`).run(leaseToken, now + this.leaseMs, ...pending.map(row => row.id))
      return pending
    })()
    return json(res, 200, {
      events: rows.map(row => ({ id: row.id, provider: row.provider, accountId: row.account_id, providerEventId: row.provider_event_id, body: row.body.toString('base64'), contentType: row.content_type, receivedAt: row.received_at, expiresAt: row.expires_at, leaseToken })),
      nextAfter: rows.at(-1)?.id || afterId,
    })
  }

  async ack(req, res, businessId, id) {
    let body
    try { body = JSON.parse((await this.readBody(req)).toString('utf8') || '{}') } catch (error) { return text(res, error.statusCode || 400, 'JSON acknowledgement required') }
    const row = this.db.prepare('SELECT provider, lease_token, status FROM relay_events WHERE id = ? AND business_id = ?').get(id, businessId)
    const credentials = row && this.secretFor(businessId, row.provider)
    if (!row || !credentials || !this.authAgent(req, credentials)) return text(res, 401, 'Agent authentication required')
    if (row.status !== 'leased' || typeof body.leaseToken !== 'string' || body.leaseToken !== row.lease_token) return text(res, 409, 'Event lease is stale')
    const commitId = typeof body.localCommitId === 'string' && body.localCommitId.length <= 256 ? body.localCommitId : null
    const now = this.clock()
    this.db.prepare(`UPDATE relay_events SET status = 'acknowledged', body = NULL, lease_token = NULL, lease_expires_at = NULL, acknowledged_at = ?, local_commit_id = ? WHERE id = ? AND status = 'leased' AND lease_token = ?`).run(now, commitId, id, body.leaseToken)
    return json(res, 200, { acknowledged: true, id, acknowledgedAt: now, localCommitId: commitId })
  }

  async start({ host = '127.0.0.1', port = 0 } = {}) {
    if (this.requireTls && !(this.tlsKey && this.tlsCert)) throw new Error('TLS key and certificate required')
    const handler = (req, res) => { this.handle(req, res).catch(error => { this.logger.error?.('[relay] request failed', error); if (!res.headersSent) text(res, 500, 'Relay request failed'); else res.destroy() }) }
    this.server = this.tlsKey && this.tlsCert ? https.createServer({ key: this.tlsKey, cert: this.tlsCert }, handler) : http.createServer(handler)
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 10_000
    this.server.keepAliveTimeout = 5_000
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, resolve) })
    const address = this.server.address()
    const protocol = this.tlsKey && this.tlsCert ? 'https' : 'http'
    return { origin: `${protocol}://${host}:${address.port}`, port: address.port, protocol }
  }

  async stop() {
    if (!this.server) return
    await new Promise(resolve => this.server.close(() => resolve()))
    this.server = null
    this.db.close()
  }
}

function readOptionalFile(value) {
  return value ? fs.readFileSync(value) : undefined
}

function relayFromEnv(env = process.env) {
  const businessId = safeSegment(env.AICA_RELAY_BUSINESS_ID || '', 'business id')
  const provider = safeSegment(env.AICA_RELAY_PROVIDER || 'whatsapp-cloud', 'provider')
  return new PublicRelay({
    dbPath: env.AICA_RELAY_DB_PATH || path.resolve(process.cwd(), 'relay-data', 'relay.db'),
    businessSecrets: { [`${businessId}:${provider}`]: { providerSecret: env.AICA_RELAY_PROVIDER_SECRET, agentSecret: env.AICA_RELAY_AGENT_SECRET } },
    requireTls: env.AICA_RELAY_REQUIRE_TLS === 'true',
    tlsKey: readOptionalFile(env.AICA_RELAY_TLS_KEY_PATH),
    tlsCert: readOptionalFile(env.AICA_RELAY_TLS_CERT_PATH),
  })
}

module.exports = { PublicRelay, relayFromEnv, timingSafeHex, bodyEventId, bodyAccountId }
