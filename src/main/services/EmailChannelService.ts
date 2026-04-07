import { EventEmitter } from 'events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface EmailConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  lastSyncAt: number | null
  unreadCount: number
}

export interface EmailPollingConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  pollingIntervalSeconds: number
  maxEmailsPerPoll?: number
  accountName?: string
  unreadOnly?: boolean
}

export interface InboundEmailMessage {
  id: string
  from: string
  to: string
  subject: string
  body: string
  bodyType: 'text' | 'html'
  timestamp: number
  messageId?: string
  inReplyTo?: string
  references?: string
  isFromMe: boolean
}

export interface OutboundEmailPayload {
  to: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
  accountName?: string
}

const RECENT_EMAIL_WINDOW_MS = 60 * 60 * 1000

function extractStructured(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {}
  const r = result as Record<string, unknown>

  if (r.structuredContent && typeof r.structuredContent === 'object') {
    return r.structuredContent as Record<string, unknown>
  }

  const content = r.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p.type === 'text' && typeof p.text === 'string') {
          try {
            const parsed = JSON.parse(p.text)
            if (parsed && typeof parsed === 'object') {
              return parsed as Record<string, unknown>
            }
          } catch {
            // Ignore non-JSON text payloads.
          }
        }
      }
    }
  }
  return {}
}

function asArray(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return []
  return input.filter((v) => typeof v === 'object' && v !== null) as Record<string, unknown>[]
}

function readString(obj: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return fallback
}

function readNumber(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return fallback
}

function readBoolean(obj: Record<string, unknown>, keys: string[], fallback = false): boolean {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') {
      const n = v.trim().toLowerCase()
      if (['true', '1', 'yes', 'y'].includes(n)) return true
      if (['false', '0', 'no', 'n'].includes(n)) return false
    }
  }
  return fallback
}

export class EmailChannelService extends EventEmitter {
  private state: EmailConnectionState = {
    status: 'disconnected',
    error: null,
    lastSyncAt: null,
    unreadCount: 0
  }

  private config: EmailPollingConfig | null = null
  private client: Client | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private seenMessageIds = new Set<string>()
  private running = false

  configure(config: EmailPollingConfig): void {
    this.config = {
      ...config,
      pollingIntervalSeconds: Math.max(30, config.pollingIntervalSeconds || 60),
      maxEmailsPerPoll: Math.max(1, Math.min(config.maxEmailsPerPoll || 10, 50)),
      unreadOnly: config.unreadOnly === true
    }
  }

  getConnectionState(): EmailConnectionState {
    return { ...this.state }
  }

  async start(): Promise<void> {
    if (this.running) return
    if (!this.config) throw new Error('Email channel is not configured')

    this.running = true
    this.setState({ status: 'connecting', error: null, unreadCount: 0, lastSyncAt: null })

    try {
      const env = { ...process.env, ...(this.config.env || {}) } as Record<string, string>
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env,
        stderr: 'pipe'
      })
      this.client = new Client({ name: 'aica-email-client', version: '0.1.0' }, { capabilities: {} })
      await this.client.connect(transport)

      this.seenMessageIds.clear()
      this.setState({ status: 'connected', error: null, lastSyncAt: Date.now(), unreadCount: 0 })

      // Run an immediate poll so first sync is fast.
      await this.pollOnce()
      this.schedulePoll()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.running = false
      this.setState({ status: 'error', error: message, lastSyncAt: null, unreadCount: 0 })
      throw error
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Ignore close failures.
      }
      this.client = null
    }
    this.seenMessageIds.clear()
    this.setState({ status: 'disconnected', error: null, lastSyncAt: null, unreadCount: 0 })
  }

  async send(payload: OutboundEmailPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.client || !this.config) {
      return { success: false, error: 'Email channel is not connected' }
    }

    try {
      const args = {
        account_name: payload.accountName || this.config.accountName || 'default',
        recipients: [payload.to],
        subject: payload.subject,
        body: payload.body,
        in_reply_to: payload.inReplyTo,
        references: payload.references
      }

      await this.client.callTool({
        name: 'send_email',
        arguments: args
      })

      this.emit('deliveryStatus', {
        to: payload.to,
        subject: payload.subject,
        status: 'sent',
        at: Date.now()
      })
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit('deliveryStatus', {
        to: payload.to,
        subject: payload.subject,
        status: 'failed',
        error: message,
        at: Date.now()
      })
      return { success: false, error: message }
    }
  }

  private schedulePoll(): void {
    if (!this.running || !this.config) return
    if (this.pollTimer) clearTimeout(this.pollTimer)

    this.pollTimer = setTimeout(async () => {
      if (!this.running) return
      await this.pollOnce()
      this.schedulePoll()
    }, this.config.pollingIntervalSeconds * 1000)
  }

  private async pollOnce(): Promise<void> {
    if (!this.client || !this.config) return

    try {
      const accountName = this.config.accountName || 'default'
      const limit = this.config.maxEmailsPerPoll || 10
      const unreadOnly = this.config.unreadOnly ?? true
      const metadata = await this.fetchMetadata(accountName, limit, unreadOnly)
      let unreadCount = 0
      let processed = 0

      const ids: string[] = metadata.ids
      unreadCount = metadata.unreadCount

      if (ids.length > 0) {
        for (const emailId of ids) {
          const contentPayload = await this.client.callTool({
            name: 'get_emails_content',
            arguments: { account_name: accountName, email_ids: [emailId] }
          })
          const structured = extractStructured(contentPayload)
          const emails = asArray(structured.emails || structured.messages || structured.results)
          for (const emailObj of emails) {
            const email = this.toInboundEmail(emailObj)
            if (!this.shouldProcessInbound(email, emailObj)) continue
            const dedupeId = email.messageId || email.id
            if (dedupeId && this.seenMessageIds.has(dedupeId)) continue
            if (dedupeId) this.seenMessageIds.add(dedupeId)
            this.emit('message', email)
            processed += 1
          }
        }
      }

      // Some server builds prefer/only expose "fetch_emails".
      // Fall back to it when metadata/content strategy yields no messages.
      if (processed === 0) {
        const directEmails = await this.fetchEmailsDirect(accountName, limit, unreadOnly)
        for (const emailObj of directEmails) {
          const email = this.toInboundEmail(emailObj)
          if (!this.shouldProcessInbound(email, emailObj)) continue
          const dedupeId = email.messageId || email.id
          if (dedupeId && this.seenMessageIds.has(dedupeId)) continue
          if (dedupeId) this.seenMessageIds.add(dedupeId)
          this.emit('message', email)
          processed += 1
        }
      }

      this.setState({ ...this.state, status: 'connected', error: null, lastSyncAt: Date.now(), unreadCount })
      if (processed > 0) {
        console.log(`[EmailChannelService] Processed ${processed} inbound email message(s)`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[EmailChannelService] Poll failure:', message)
      if (/disconnect|ECONN|closed/i.test(message)) {
        this.setState({ ...this.state, status: 'error', error: message })
      }
    }
  }

  private async fetchMetadata(
    accountName: string,
    limit: number,
    unreadOnly: boolean
  ): Promise<{ ids: string[]; unreadCount: number }> {
    if (!this.client) return { ids: [], unreadCount: 0 }

    const candidates = [
      { name: 'list_emails_metadata', args: { account_name: accountName, limit, unread_only: unreadOnly } },
      { name: 'list_emails_metadata', args: { account_name: accountName, max_count: limit, unread_only: unreadOnly } },
      { name: 'list_emails', args: { account_name: accountName, limit, unread_only: unreadOnly } }
    ]

    for (const candidate of candidates) {
      try {
        const result = await this.client.callTool({
          name: candidate.name,
          arguments: candidate.args
        })
        const structured = extractStructured(result)
        const idsFromArray = Array.isArray(structured.ids)
          ? structured.ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
          : []
        const list = asArray(structured.emails || structured.messages || structured.results || structured.items)
        const idsFromList = list
          .map((item) => readString(item, ['id', 'email_id', 'uid']))
          .filter((id) => id !== '')
        const ids = idsFromList.length > 0 ? idsFromList : idsFromArray
        const unreadCount = readNumber(structured, ['unread_count', 'unreadCount'], ids.length)
        return { ids, unreadCount }
      } catch {
        // Try next variant.
      }
    }

    return { ids: [], unreadCount: 0 }
  }

  private async fetchEmailsDirect(
    accountName: string,
    limit: number,
    unreadOnly: boolean
  ): Promise<Record<string, unknown>[]> {
    if (!this.client) return []
    try {
      const result = await this.client.callTool({
        name: 'fetch_emails',
        arguments: {
          account_name: accountName,
          max_count: limit,
          unread_only: unreadOnly
        }
      })
      const structured = extractStructured(result)
      const emails = asArray(structured.emails || structured.messages || structured.results || structured.items)
      return emails
    } catch {
      return []
    }
  }

  private toInboundEmail(item: Record<string, unknown>): InboundEmailMessage {
    const timestampSec = readNumber(item, ['date_ts', 'timestamp', 'received_at_ts'], Date.now())
    const timestamp = timestampSec < 2_000_000_000 ? timestampSec * 1000 : timestampSec

    return {
      id: readString(item, ['id', 'email_id', 'uid'], `email_${Date.now()}`),
      from: readString(item, ['from', 'sender', 'from_address']),
      to: readString(item, ['to', 'recipients', 'to_address']),
      subject: readString(item, ['subject'], '(No Subject)'),
      body: readString(item, ['body', 'text', 'plain_text', 'content']),
      bodyType: readString(item, ['body_type', 'content_type'], 'text').toLowerCase().includes('html') ? 'html' : 'text',
      timestamp,
      messageId: readString(item, ['message_id', 'messageId']),
      inReplyTo: readString(item, ['in_reply_to', 'inReplyTo']),
      references: readString(item, ['references']),
      isFromMe: false
    }
  }

  private shouldProcessInbound(email: InboundEmailMessage, raw?: Record<string, unknown>): boolean {
    if (!email.from || email.isFromMe) return false

    const now = Date.now()
    if (email.timestamp > 0 && now - email.timestamp > RECENT_EMAIL_WINDOW_MS) return false

    if (raw) {
      const alreadyHandled = readBoolean(raw, [
        'answered',
        'is_answered',
        'isAnswered',
        'replied',
        'is_replied',
        'isReplied'
      ], false)
      if (alreadyHandled) return false
    }

    return true
  }

  private setState(next: EmailConnectionState): void {
    this.state = { ...next }
    this.emit('connectionChange', this.getConnectionState())
  }
}

export const emailChannelService = new EmailChannelService()
