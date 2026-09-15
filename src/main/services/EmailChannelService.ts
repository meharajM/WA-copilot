import { EventEmitter } from 'events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import Store from 'electron-store'
import { buildGmailQuery, toInboundGmailMessage } from './email-gmail'
import { gmailOAuthService } from './GmailOAuthService'
import { ChannelAttachment, normalizeEmailMessage } from '../packages/omnichannel'
import { isEmailDeliveryBounce, isGmailAuthFailure, normalizeEmailAttachmentMetadata, shouldProcessEmailInbound } from './EmailInboundPolicy'
import { createHash } from 'node:crypto'
import { claimEmailSend, getEmailProviderMessageId, markEmailFailed, markEmailSent } from './EmailOutbox'

interface EmailSyncState {
  seenMessageIds: string[];
  gmailLastSyncTimestamp: number;
}

const emailSyncStore = new Store<EmailSyncState>({
  name: 'email-sync-state',
  defaults: {
    seenMessageIds: [],
    gmailLastSyncTimestamp: 0
  }
}) as Store<EmailSyncState> & {
  get: <K extends keyof EmailSyncState>(key: K) => EmailSyncState[K] | undefined
  set: <K extends keyof EmailSyncState>(key: K, value: EmailSyncState[K]) => void
}

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
  provider?: string
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
  attachments?: ChannelAttachment[]
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

function extractToolError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if (r.isError !== true) return null

  const content = r.content
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          return typeof p.text === 'string' ? p.text : ''
        }
        return ''
      })
      .filter((t) => t !== '')
      .join(' | ')
    return text || 'MCP tool returned isError=true'
  }
  return 'MCP tool returned isError=true'
}

function isAuthError(message: string): boolean {
  return /NONAUTH|AUTHENTICATION|LOGIN failed|invalid credentials/i.test(message)
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

function parseEmailAddress(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return ''
    const match = trimmed.match(/<([^>]+@[^>]+)>/)
    if (match?.[1]) return match[1].trim().toLowerCase()
    if (trimmed.includes('@')) return trimmed.toLowerCase()
    return ''
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const parsed = parseEmailAddress(item)
      if (parsed) return parsed
    }
    return ''
  }

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    return (
      parseEmailAddress(obj.email) ||
      parseEmailAddress(obj.address) ||
      parseEmailAddress(obj.value) ||
      parseEmailAddress(obj.mailbox)
    )
  }

  return ''
}

function parseTimestampMs(item: Record<string, unknown>): number {
  const numeric = readNumber(item, ['date_ts', 'timestamp', 'received_at_ts', 'received_ts', 'internal_date'], 0)
  if (numeric > 0) {
    return numeric < 2_000_000_000 ? numeric * 1000 : numeric
  }

  const candidates = [
    item.date,
    item.received_at,
    item.receivedAt,
    item.sent_at,
    item.sentAt,
    item.internalDate
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const parsed = Date.parse(c)
      if (!Number.isNaN(parsed)) return parsed
    }
  }

  return Date.now()
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
  private seenMessageIds: Set<string>;
  private running = false
  private effectiveAccountName: string | null = null
  private availableToolNames: string[] = []
  private lastAuthErrorAt = 0
  private authFailureInCurrentPoll = false
  private watchTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.seenMessageIds = new Set<string>(emailSyncStore.get('seenMessageIds') ?? [])
  }

  configure(config: EmailPollingConfig): void {
    this.config = {
      ...config,
      pollingIntervalSeconds: Math.max(30, config.pollingIntervalSeconds || 60),
      maxEmailsPerPoll: Math.max(1, Math.min(config.maxEmailsPerPoll || 10, 50)),
      unreadOnly: config.unreadOnly === true
    }
    console.log('[EmailChannelService] configured', {
      accountName: this.config.accountName,
      pollingIntervalSeconds: this.config.pollingIntervalSeconds,
      maxEmailsPerPoll: this.config.maxEmailsPerPoll,
      unreadOnly: this.config.unreadOnly
    })
  }

  getConnectionState(): EmailConnectionState {
    return { ...this.state }
  }

  async start(): Promise<void> {
    if (this.running) return
    if (!this.config) throw new Error('Email channel is not configured')

    console.log('[EmailChannelService] start requested')
    this.running = true
    this.setState({ status: 'connecting', error: null, unreadCount: 0, lastSyncAt: null })

    try {
      if (this.config.provider === 'gmail-api') {
        await gmailOAuthService.initialize()
        const token = await gmailOAuthService.getAccessToken()
        if (!token) {
          throw new Error('Gmail OAuth is not connected. Sign in with Google in Email settings.')
        }
        console.log('[EmailChannelService] Gmail OAuth mode enabled')
      } else {
        const env = { ...process.env, ...(this.config.env || {}) } as Record<string, string>
        const transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args || [],
          env,
          stderr: 'pipe'
        })
        this.client = new Client({ name: 'aica-email-client', version: '0.1.0' }, { capabilities: {} })
        await this.client.connect(transport)
        console.log('[EmailChannelService] MCP client connected')
        try {
          const toolsResult = await this.client.listTools()
          const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
          this.availableToolNames = tools
            .map((t) => (t && typeof t.name === 'string' ? t.name : ''))
            .filter((n) => n !== '')
          console.log('[EmailChannelService] available tools', this.availableToolNames)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.availableToolNames = []
          console.log('[EmailChannelService] listTools unavailable', { error: message })
        }
      }

      this.effectiveAccountName = null
      this.setState({ status: 'connected', error: null, lastSyncAt: Date.now(), unreadCount: 0 })

      // Run an immediate poll so first sync is fast.
      await this.pollOnce()
      if (this.config.provider === 'gmail-api' && process.env.GMAIL_PUBSUB_TOPIC) void this.renewGmailWatch()
      this.schedulePoll()
      console.log('[EmailChannelService] polling scheduled')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.running = false
      this.setState({ status: 'error', error: message, lastSyncAt: null, unreadCount: 0 })
      throw error
    }
  }

  async stop(): Promise<void> {
    console.log('[EmailChannelService] stop requested')
    this.running = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer)
      this.watchTimer = null
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
    this.effectiveAccountName = null
    this.availableToolNames = []
    this.setState({ status: 'disconnected', error: null, lastSyncAt: null, unreadCount: 0 })
  }

  async send(payload: OutboundEmailPayload): Promise<{ success: boolean; error?: string; providerMessageId?: string }> {
    const dedupeKey = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const claim = claimEmailSend(dedupeKey, payload)
    if (claim === 'sent') return { success: true, providerMessageId: getEmailProviderMessageId(dedupeKey) }
    if (claim === 'inflight') return { success: false, error: 'Email send is already pending reconciliation' }
    if (this.config?.provider === 'gmail-api') {
      try {
        const accessToken = await gmailOAuthService.getAccessToken()
        if (!accessToken) { markEmailFailed(dedupeKey, 'Gmail OAuth token missing'); return { success: false, error: 'Gmail OAuth token missing' } }
        const headers = [
          `To: ${payload.to}`,
          `Subject: ${payload.subject}`,
          'Content-Type: text/plain; charset=UTF-8'
        ]
        
        if (payload.inReplyTo) {
          headers.push(`In-Reply-To: ${payload.inReplyTo}`)
        }
        
        if (payload.references) {
          headers.push(`References: ${payload.references}`)
        }
        
        const mime = [
          ...headers,
          '',
          payload.body
        ].join('\r\n')
        const raw = Buffer.from(mime).toString('base64url')
        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ raw })
        })
        if (!response.ok) {
          const text = await response.text()
          const error = isGmailAuthFailure(response.status) ? 'Gmail OAuth authorization expired or was revoked; sign in again' : `Gmail send failed: ${text}`
          markEmailFailed(dedupeKey, error)
          return { success: false, error }
        }
        const sent = await response.json().catch(() => ({})) as { id?: string }
        markEmailSent(dedupeKey, sent.id)
        if (sent.id) this.emit('deliveryStatus', { providerMessageId: sent.id, to: payload.to, subject: payload.subject, status: 'sent', at: Date.now() })
        return { success: true, providerMessageId: sent.id }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        markEmailFailed(dedupeKey, message)
        return { success: false, error: message }
      }
    }

    if (!this.client || !this.config) {
      markEmailFailed(dedupeKey, 'Email channel is not connected')
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

      const result = await this.client.callTool({
        name: 'send_email',
        arguments: args
      })
      const toolError = extractToolError(result)
      if (toolError) throw new Error(toolError)
      const structured = extractStructured(result)
      const providerMessageId = typeof structured.id === 'string' ? structured.id : typeof structured.message_id === 'string' ? structured.message_id : undefined

      this.emit('deliveryStatus', {
        providerMessageId,
        to: payload.to,
        subject: payload.subject,
        status: 'sent',
        at: Date.now()
      })
      markEmailSent(dedupeKey, providerMessageId)
      return { success: true, providerMessageId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit('deliveryStatus', {
        to: payload.to,
        subject: payload.subject,
        status: 'failed',
        error: message,
        at: Date.now()
      })
      markEmailFailed(dedupeKey, message)
      return { success: false, error: message }
    }
  }

  private schedulePoll(): void {
    if (!this.running || !this.config) return
    if (this.pollTimer) clearTimeout(this.pollTimer)

    this.pollTimer = setTimeout(async () => {
      if (!this.running) return
      console.log('[EmailChannelService] poll tick')
      await this.pollOnce()
      this.schedulePoll()
    }, this.config.pollingIntervalSeconds * 1000)
  }

  private async pollOnce(): Promise<void> {
    if (!this.config) return

    try {
      if (this.config.provider === 'gmail-api') {
        await this.pollViaGmailApi()
        return
      }
      if (!this.client) return
      this.authFailureInCurrentPoll = false
      const accountName = await this.resolveAccountName()
      const limit = this.config.maxEmailsPerPoll || 10
      const unreadOnly = this.config.unreadOnly ?? true
      const metadata = await this.fetchMetadata(accountName, limit, unreadOnly)
      console.log('[EmailChannelService] poll metadata', {
        accountName,
        ids: metadata.ids.length,
        unreadCount: metadata.unreadCount,
        limit
      })
      let unreadCount = 0
      let processed = 0
      let skippedFiltered = 0
      let skippedDuplicate = 0

      const ids: string[] = metadata.ids
      unreadCount = metadata.unreadCount

      if (ids.length > 0) {
        for (const emailId of ids) {
          const emails = await this.getEmailsContent(accountName, emailId)
          if (emails.length === 0) {
            console.log('[EmailChannelService] content lookup empty', { emailId })
          }
          for (const emailObj of emails) {
            const email = this.toInboundEmail(emailObj)
            if (!this.shouldProcessInbound(email, emailObj)) {
              skippedFiltered += 1
              continue
            }
            const dedupeId = email.messageId || email.id
            if (dedupeId && this.seenMessageIds.has(dedupeId)) {
              skippedDuplicate += 1
              continue
            }
            if (dedupeId) this.seenMessageIds.add(dedupeId)
            this.emit('message', { ...email, ...normalizeEmailMessage(email) })
            processed += 1
          }
        }
      }

      // Some server builds prefer/only expose "fetch_emails".
      // Fall back to it when metadata/content strategy yields no messages.
      if (processed === 0) {
        const directEmails = await this.fetchEmailsDirect(accountName, limit, unreadOnly)
        console.log('[EmailChannelService] direct fetch fallback', { count: directEmails.length })
        for (const emailObj of directEmails) {
          const email = this.toInboundEmail(emailObj)
          if (!this.shouldProcessInbound(email, emailObj)) {
            skippedFiltered += 1
            continue
          }
          const dedupeId = email.messageId || email.id
          if (dedupeId && this.seenMessageIds.has(dedupeId)) {
            skippedDuplicate += 1
            continue
          }
          if (dedupeId) this.seenMessageIds.add(dedupeId)
          this.emit('message', { ...email, ...normalizeEmailMessage(email) })
          processed += 1
        }
      }

      if (this.authFailureInCurrentPoll) {
        console.log('[EmailChannelService] poll ended with auth failure; preserving error state')
        return
      }

      console.log('[EmailChannelService] poll result', {
        processed,
        skippedFiltered,
        skippedDuplicate,
        seenSize: this.seenMessageIds.size
      })
      this.setState({ ...this.state, status: 'connected', error: null, lastSyncAt: Date.now(), unreadCount })
      
      const seenArray = Array.from(this.seenMessageIds);
      if (seenArray.length > 2000) {
        this.seenMessageIds = new Set(seenArray.slice(-1000));
      }
      emailSyncStore.set('seenMessageIds', Array.from(this.seenMessageIds));

      if (processed > 0) {
        console.log(`[EmailChannelService] Processed ${processed} inbound email message(s)`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[EmailChannelService] Poll failure:', message)
      this.setState({ ...this.state, status: 'error', error: message })
    }
  }

  private async renewGmailWatch(): Promise<void> {
    const topic = process.env.GMAIL_PUBSUB_TOPIC
    if (!topic || this.config?.provider !== 'gmail-api' || !this.running) return
    try {
      const watch = await gmailOAuthService.renewWatch(topic)
      const delay = Math.max(60 * 60 * 1000, Math.min((watch.expiration || Date.now() + 6 * 24 * 60 * 60 * 1000) - Date.now() - 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000))
      this.watchTimer = setTimeout(() => void this.renewGmailWatch(), delay)
      console.log('[EmailChannelService] Gmail watch renewed', { expiration: watch.expiration, historyId: watch.historyId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ ...this.state, status: 'error', error: message })
      console.error('[EmailChannelService] Gmail watch renewal failed; polling remains active:', message)
    }
  }

  private async pollViaGmailApi(): Promise<void> {
    const accessToken = await gmailOAuthService.getAccessToken()
    if (!accessToken) {
      this.setState({ ...this.state, status: 'error', error: 'Gmail OAuth token missing' })
      return
    }

    const lastSyncSecs = emailSyncStore.get('gmailLastSyncTimestamp') ?? 0
    const queryParam = buildGmailQuery(lastSyncSecs, this.config?.unreadOnly === true)
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    listUrl.searchParams.set('maxResults', String(this.config?.maxEmailsPerPoll || 10))
    listUrl.searchParams.set('q', queryParam)
    listUrl.searchParams.append('labelIds', 'INBOX')
    const ownerEmail = parseEmailAddress(gmailOAuthService.getStatus().email || '')

    const response = await fetch(
      listUrl.toString(),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!response.ok) {
      const text = await response.text()
      this.setState({ ...this.state, status: 'error', error: `Gmail list failed: ${text}` })
      return
    }

    const listData = await response.json() as { messages?: Array<{ id: string }> }
    const messages = listData.messages || []
    let processed = 0
    for (const m of messages) {
      const detailResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      if (!detailResp.ok) continue
      const detail = await detailResp.json() as Record<string, unknown>
      const email = toInboundGmailMessage(detail, ownerEmail)
      if (!email || !this.shouldProcessInbound(email, detail)) continue
      const dedupeId = email.messageId || email.id
      if (dedupeId && this.seenMessageIds.has(dedupeId)) continue
      if (dedupeId) this.seenMessageIds.add(dedupeId)
      this.emit('message', { ...email, ...normalizeEmailMessage(email) })
      processed += 1
    }

    this.setState({ ...this.state, status: 'connected', error: null, lastSyncAt: Date.now(), unreadCount: messages.length })
    
    // Save state overlap for 5 mins
    emailSyncStore.set('gmailLastSyncTimestamp', Math.floor(Date.now() / 1000) - 300)
    
    const seenArray = Array.from(this.seenMessageIds);
    if (seenArray.length > 2000) {
      this.seenMessageIds = new Set(seenArray.slice(-1000));
    }
    emailSyncStore.set('seenMessageIds', Array.from(this.seenMessageIds));

    if (processed > 0) console.log(`[EmailChannelService] Gmail API processed ${processed} message(s)`)
  }

  private async fetchMetadata(
    accountName: string,
    limit: number,
    unreadOnly: boolean
  ): Promise<{ ids: string[]; unreadCount: number }> {
    if (!this.client) return { ids: [], unreadCount: 0 }

    const sinceIso = new Date(Date.now() - RECENT_EMAIL_WINDOW_MS).toISOString()
    const seenFilter = unreadOnly ? false : undefined

    const mailboxCandidates = ['INBOX', '[Gmail]/All Mail', 'All Mail']
    const candidates = [
      // Broadest first: avoid over-filtering due provider/tool differences.
      {
        name: 'list_emails_metadata',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit
        }
      },
      {
        name: 'list_emails_metadata',
        args: {
          page: 1,
          page_size: limit
        }
      },
      {
        name: 'list_emails_metadata',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit,
          mailbox: 'INBOX',
          since: sinceIso,
          seen: seenFilter,
          answered: false
        }
      },
      {
        name: 'list_emails_metadata',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit,
          mailbox: 'INBOX',
          since: sinceIso,
          seen: seenFilter
        }
      },
      {
        name: 'page_email',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit,
          mailbox: 'INBOX',
          since: sinceIso
        }
      },
      ...mailboxCandidates.map((mailbox) => ({
        name: 'list_emails',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit,
          mailbox,
          since: sinceIso
        }
      })),
      ...mailboxCandidates.map((mailbox) => ({
        name: 'list_emails_metadata',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit,
          mailbox
        }
      })),
      {
        name: 'list_emails',
        args: {
          page: 1,
          page_size: limit
        }
      }
    ]

    for (const candidate of candidates) {
      if (this.availableToolNames.length > 0 && !this.availableToolNames.includes(candidate.name)) {
        continue
      }
      try {
        const result = await this.client.callTool({
          name: candidate.name,
          arguments: candidate.args
        })
        const toolError = extractToolError(result)
        if (toolError) {
          console.log('[EmailChannelService] metadata candidate MCP error', {
            tool: candidate.name,
            args: Object.keys(candidate.args),
            error: toolError
          })
          if (isAuthError(toolError)) {
            this.authFailureInCurrentPoll = true
            const now = Date.now()
            if (now - this.lastAuthErrorAt > 10_000) {
              this.lastAuthErrorAt = now
              this.setState({
                ...this.state,
                status: 'error',
                error: 'Email authentication failed (IMAP NONAUTH). Recheck app password/token, username, and IMAP access.'
              })
            }
          }
          continue
        }
        const structured = extractStructured(result)
        const idsFromArray = Array.isArray(structured.ids)
          ? structured.ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
          : []
        const list = asArray(structured.emails || structured.messages || structured.results || structured.items || structured.data)
        const idsFromList = list
          .map((item) => readString(item, ['id', 'email_id', 'uid', 'emailId']))
          .filter((id) => id !== '')
        const ids = idsFromList.length > 0 ? idsFromList : idsFromArray
        const unreadCount = readNumber(structured, ['unread_count', 'unreadCount'], ids.length)
        console.log('[EmailChannelService] metadata candidate result', {
          tool: candidate.name,
          args: Object.keys(candidate.args),
          ids: ids.length
        })
        if (ids.length > 0) {
          console.log('[EmailChannelService] metadata candidate matched', {
            tool: candidate.name,
            args: Object.keys(candidate.args),
            ids: ids.length
          })
        }
        return { ids, unreadCount }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log('[EmailChannelService] metadata candidate failed', { tool: candidate.name, error: message })
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
    const sinceIso = new Date(Date.now() - RECENT_EMAIL_WINDOW_MS).toISOString()
    const candidates = [
      {
        name: 'fetch_emails',
        args: {
          account_name: accountName,
          max_count: limit
        }
      },
      {
        name: 'fetch_emails',
        args: {
          max_count: limit
        }
      },
      {
        name: 'fetch_emails',
        args: {
          account_name: accountName,
          max_count: limit,
          unread_only: unreadOnly,
          since: sinceIso
        }
      },
      {
        name: 'page_email',
        args: {
          account_name: accountName,
          page: 1,
          page_size: limit,
          mailbox: 'INBOX',
          since: sinceIso
        }
      }
    ]

    for (const candidate of candidates) {
      if (this.availableToolNames.length > 0 && !this.availableToolNames.includes(candidate.name)) {
        continue
      }
      try {
        const result = await this.client.callTool({
          name: candidate.name,
          arguments: candidate.args
        })
        const toolError = extractToolError(result)
        if (toolError) {
          console.log('[EmailChannelService] direct candidate MCP error', {
            tool: candidate.name,
            args: Object.keys(candidate.args),
            error: toolError
          })
          if (isAuthError(toolError)) {
            this.authFailureInCurrentPoll = true
            const now = Date.now()
            if (now - this.lastAuthErrorAt > 10_000) {
              this.lastAuthErrorAt = now
              this.setState({
                ...this.state,
                status: 'error',
                error: 'Email authentication failed (IMAP NONAUTH). Recheck app password/token, username, and IMAP access.'
              })
            }
          }
          continue
        }
        const structured = extractStructured(result)
        const emails = asArray(structured.emails || structured.messages || structured.results || structured.items || structured.data)
        console.log('[EmailChannelService] direct candidate result', {
          tool: candidate.name,
          args: Object.keys(candidate.args),
          count: emails.length
        })
        if (emails.length > 0) {
          console.log('[EmailChannelService] direct candidate matched', {
            tool: candidate.name,
            args: Object.keys(candidate.args),
            count: emails.length
          })
          return emails
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log('[EmailChannelService] direct candidate failed', { tool: candidate.name, error: message })
      }
    }
    return []
  }

  private async resolveAccountName(): Promise<string> {
    if (!this.client || !this.config) return this.config?.accountName || 'default'
    if (this.effectiveAccountName) return this.effectiveAccountName

    const requested = this.config.accountName || 'default'
    let names: string[] = []
    try {
      const result = await this.client.callTool({
        name: 'list_available_accounts',
        arguments: {}
      })
      const raw = result as Record<string, unknown>
      const structuredUnknown = raw?.structuredContent
      const structured = extractStructured(result)
      const accounts = Array.isArray(structuredUnknown)
        ? structuredUnknown
        : (Array.isArray(structured.accounts) ? structured.accounts : [])
      names = accounts
        .map((a) => (a && typeof a === 'object' ? readString(a as Record<string, unknown>, ['account_name', 'accountName', 'name']) : ''))
        .filter((n) => n !== '')
      console.log('[EmailChannelService] available accounts', names)

      if (names.includes(requested)) {
        this.effectiveAccountName = requested
        return requested
      }
      if (names.length > 0) {
        console.log('[EmailChannelService] account auto-resolved', { requested, resolved: names[0], available: names })
        this.effectiveAccountName = names[0]
        return names[0]
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log('[EmailChannelService] list_available_accounts unavailable', { error: message })
    }

    // Attempt one-time bootstrap if account is missing.
    if (!names.includes(requested)) {
      const bootstrapped = await this.tryBootstrapAccount(requested)
      if (bootstrapped) {
        try {
          const result = await this.client.callTool({
            name: 'list_available_accounts',
            arguments: {}
          })
          const raw = result as Record<string, unknown>
          const structuredUnknown = raw?.structuredContent
          const structured = extractStructured(result)
          const accounts = Array.isArray(structuredUnknown)
            ? structuredUnknown
            : (Array.isArray(structured.accounts) ? structured.accounts : [])
          const refreshed = accounts
            .map((a) => (a && typeof a === 'object' ? readString(a as Record<string, unknown>, ['account_name', 'accountName', 'name']) : ''))
            .filter((n) => n !== '')
          console.log('[EmailChannelService] available accounts after bootstrap', refreshed)
          if (refreshed.includes(requested)) {
            this.effectiveAccountName = requested
            return requested
          }
          if (refreshed.length > 0) {
            this.effectiveAccountName = refreshed[0]
            return refreshed[0]
          }
        } catch {
          // Fall through to requested.
        }
      }
    }

    this.effectiveAccountName = requested
    return requested
  }

  private async tryBootstrapAccount(accountName: string): Promise<boolean> {
    if (!this.client || !this.config?.env) return false
    const env = this.config.env
    const email = env.MCP_EMAIL_SERVER_EMAIL_ADDRESS
    const user = env.MCP_EMAIL_SERVER_USER_NAME
    const password = env.MCP_EMAIL_SERVER_PASSWORD
    const imapHost = env.MCP_EMAIL_SERVER_IMAP_HOST
    const imapPort = Number(env.MCP_EMAIL_SERVER_IMAP_PORT || '993')
    const smtpHost = env.MCP_EMAIL_SERVER_SMTP_HOST
    const smtpPort = Number(env.MCP_EMAIL_SERVER_SMTP_PORT || '587')
    const imapSsl = (env.MCP_EMAIL_SERVER_IMAP_SSL || 'true').toLowerCase() !== 'false'
    const smtpStartTls = (env.MCP_EMAIL_SERVER_SMTP_START_SSL || 'true').toLowerCase() === 'true'
    const smtpSsl = (env.MCP_EMAIL_SERVER_SMTP_SSL || 'false').toLowerCase() === 'true'

    if (!email || !user || !password || !imapHost || !smtpHost) {
      console.log('[EmailChannelService] account bootstrap skipped: missing env fields')
      return false
    }

    const candidates = [
      {
        account_name: accountName,
        email_address: email,
        user_name: user,
        password,
        imap_host: imapHost,
        imap_port: imapPort,
        imap_ssl: imapSsl,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_start_ssl: smtpStartTls,
        smtp_ssl: smtpSsl
      },
      {
        accountName,
        emailAddress: email,
        userName: user,
        password,
        imapHost,
        imapPort,
        imapSsl,
        smtpHost,
        smtpPort,
        smtpStartTls,
        smtpSsl
      }
    ]

    for (const args of candidates) {
      try {
        await this.client.callTool({
          name: 'add_email_account',
          arguments: args
        })
        console.log('[EmailChannelService] account bootstrap success')
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log('[EmailChannelService] account bootstrap attempt failed', { error: message })
      }
    }

    return false
  }

  private async getEmailsContent(accountName: string, emailId: string): Promise<Record<string, unknown>[]> {
    if (!this.client) return []

    const candidates = [
      { name: 'get_emails_content', args: { account_name: accountName, email_ids: [emailId] } },
      { name: 'get_emails_content', args: { account_name: accountName, email_id: emailId } },
      { name: 'get_email_content', args: { account_name: accountName, email_id: emailId } },
      { name: 'get_email', args: { account_name: accountName, email_id: emailId } }
    ]

    for (const candidate of candidates) {
      try {
        const payload = await this.client.callTool({
          name: candidate.name,
          arguments: candidate.args
        })
        const toolError = extractToolError(payload)
        if (toolError) {
          console.log('[EmailChannelService] content candidate MCP error', {
            tool: candidate.name,
            args: Object.keys(candidate.args),
            error: toolError
          })
          continue
        }
        const structured = extractStructured(payload)
        const emails = asArray(structured.emails || structured.messages || structured.results || structured.items || structured.data)
        if (emails.length > 0) return emails
        if (structured && typeof structured === 'object' && Object.keys(structured).length > 0) {
          return [structured]
        }
      } catch {
        // Try next tool variant.
      }
    }
    return []
  }

  private toInboundEmail(item: Record<string, unknown>): InboundEmailMessage {
    const timestamp = parseTimestampMs(item)
    const fromAddress =
      parseEmailAddress(item.from) ||
      parseEmailAddress(item.sender) ||
      parseEmailAddress(item.from_address) ||
      parseEmailAddress(item.from_email) ||
      parseEmailAddress(item.sender_email) ||
      readString(item, ['from', 'sender', 'from_address', 'from_email', 'sender_email'])
    const toAddress =
      parseEmailAddress(item.to) ||
      parseEmailAddress(item.recipients) ||
      parseEmailAddress(item.to_address) ||
      parseEmailAddress(item.to_email) ||
      readString(item, ['to', 'recipients', 'to_address', 'to_email'])
    const fromMe = readBoolean(item, ['is_from_me', 'isFromMe', 'from_me', 'outgoing', 'sent_by_me'], false)

    return {
      id: readString(item, ['id', 'email_id', 'uid'], `email_${Date.now()}`),
      from: fromAddress || 'unknown-sender',
      to: toAddress,
      subject: readString(item, ['subject'], '(No Subject)'),
      body: readString(item, ['body', 'text', 'plain_text', 'content']),
      bodyType: readString(item, ['body_type', 'content_type'], 'text').toLowerCase().includes('html') ? 'html' : 'text',
      timestamp,
      messageId: readString(item, ['message_id', 'messageId']),
      inReplyTo: readString(item, ['in_reply_to', 'inReplyTo']),
      references: readString(item, ['references']),
      isFromMe: fromMe,
      attachments: normalizeEmailAttachmentMetadata(item)
    }
  }

  private shouldProcessInbound(email: InboundEmailMessage, raw?: Record<string, unknown>): boolean {
    if (isEmailDeliveryBounce(email, raw)) {
      const providerMessageId = email.messageId || email.id
      if (providerMessageId && !this.seenMessageIds.has(providerMessageId)) {
        this.seenMessageIds.add(providerMessageId)
        this.emit('deliveryStatus', { providerMessageId, status: 'failed', at: Date.now(), inReplyTo: email.inReplyTo })
      }
    }
    return shouldProcessEmailInbound(email, raw, Date.now())
  }

  private setState(next: EmailConnectionState): void {
    this.state = { ...next }
    this.emit('connectionChange', this.getConnectionState())
  }
}

export const emailChannelService = new EmailChannelService()
