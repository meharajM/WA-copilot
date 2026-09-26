const { URL } = require('node:url')

const MAX_BATCH = 100
const MAX_EVENT_BYTES = 1 * 1024 * 1024

class PublicRelayClient {
  constructor({ origin, businessId, provider, agentSecret, fetchImpl = globalThis.fetch, onEvent, pollIntervalMs = 30_000, allowInsecureLocalhost = false, logger = { warn() {}, error() {} } }) {
    if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) throw new Error('Relay origin must be HTTP(S)')
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' && !(allowInsecureLocalhost && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('Relay client requires HTTPS')
    if (typeof businessId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(businessId)) throw new Error('Invalid business id')
    if (typeof provider !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(provider)) throw new Error('Invalid provider')
    if (typeof agentSecret !== 'string' || agentSecret.length < 32) throw new Error('Agent secret is invalid')
    if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is required')
    if (typeof onEvent !== 'function') throw new Error('onEvent callback is required')
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000) throw new Error('pollIntervalMs must be at least 1000ms')
    this.origin = origin.replace(/\/$/, '')
    this.businessId = businessId
    this.provider = provider
    this.agentSecret = agentSecret
    this.fetchImpl = fetchImpl
    this.onEvent = onEvent
    this.pollIntervalMs = pollIntervalMs
    this.logger = logger
    this.cursor = 0
    this.timer = null
    this.inFlight = null
  }

  async request(pathname, options = {}) {
    const response = await this.fetchImpl(`${this.origin}${pathname}`, {
      ...options,
      headers: { authorization: `Bearer ${this.agentSecret}`, ...(options.headers || {}) },
    })
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    if (!response.ok) throw new Error(typeof body === 'string' ? body : body?.error || `Relay request failed (${response.status})`)
    return body
  }

  async pollOnce() {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      const body = await this.request(`/v1/agents/${encodeURIComponent(this.businessId)}/events?provider=${encodeURIComponent(this.provider)}&after=${this.cursor}&limit=${MAX_BATCH}`)
      const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_BATCH) : []
      for (const event of events) {
        if (!Number.isSafeInteger(event?.id) || typeof event.leaseToken !== 'string' || typeof event.body !== 'string') continue
        const raw = Buffer.from(event.body, 'base64')
        if (raw.length > MAX_EVENT_BYTES) throw new Error('Relay event exceeds local size bound')
        const localCommitId = await this.onEvent({
          id: event.id,
          provider: event.provider,
          accountId: event.accountId,
          providerEventId: event.providerEventId,
          contentType: event.contentType,
          receivedAt: event.receivedAt,
          expiresAt: event.expiresAt,
          body: raw,
        })
        const ack = await this.request(`/v1/agents/${encodeURIComponent(this.businessId)}/events/${event.id}/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ leaseToken: event.leaseToken, localCommitId: typeof localCommitId === 'string' ? localCommitId.slice(0, 256) : null }),
        })
        if (ack?.acknowledged !== true) throw new Error('Relay acknowledgement failed')
        this.cursor = Math.max(this.cursor, event.id)
      }
      return events.length
    })().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  start() {
    if (this.timer) return
    const run = () => this.pollOnce().catch(error => this.logger.warn?.(`[relay-client] poll failed: ${error.message}`))
    this.timer = setInterval(run, this.pollIntervalMs)
    run()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.inFlight
  }
}

module.exports = { PublicRelayClient }
