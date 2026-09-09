import { createHmac, randomBytes } from 'node:crypto'
import type { ChannelMessage } from '../packages/omnichannel'

export interface XUserContext { consumerKey: string; consumerSecret: string; accessToken: string; accessTokenSecret: string; accountId: string }
const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

export function xCrcResponse(crcToken: string, consumerSecret: string): { response_token: string } {
  return { response_token: `sha256=${createHmac('sha256', consumerSecret).update(crcToken).digest('base64')}` }
}

export function verifyXWebhookSignature(rawBody: string, signature: string | undefined, consumerSecret: string): boolean {
  if (!signature?.startsWith('sha256=') || !consumerSecret) return false
  const expected = `sha256=${createHmac('sha256', consumerSecret).update(rawBody).digest('base64')}`
  return signature === expected
}

function oauthHeader(method: string, url: string, credentials: XUserContext): string {
  const oauth: Record<string, string> = { oauth_consumer_key: credentials.consumerKey, oauth_nonce: randomBytes(12).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: credentials.accessToken, oauth_version: '1.0' }
  const parameters = Object.entries(oauth).sort().map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&')
  const base = [method.toUpperCase(), encode(url), encode(parameters)].join('&')
  const signature = createHmac('sha1', `${encode(credentials.consumerSecret)}&${encode(credentials.accessTokenSecret)}`).update(base).digest('base64')
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).sort().map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(', ')}`
}

export function normalizeXDirectMessage(payload: unknown, accountId = ''): ChannelMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const events = (payload as { events?: unknown }).events
  if (!Array.isArray(events)) return []
  return events.flatMap(event => {
    if (!event || typeof event !== 'object') return []
    const item = event as Record<string, unknown>
    if (item.type !== 'message_create' || !item.message_create || typeof item.message_create !== 'object') return []
    const create = item.message_create as Record<string, unknown>
    const sender = typeof create.sender_id === 'string' ? create.sender_id : ''
    const target = create.target && typeof create.target === 'object' ? create.target as Record<string, unknown> : {}
    const recipient = typeof target.recipient_id === 'string' ? target.recipient_id : ''
    const data = create.message_data && typeof create.message_data === 'object' ? create.message_data as Record<string, unknown> : {}
    const id = typeof item.id === 'string' ? item.id : ''
    const text = typeof data.text === 'string' ? data.text : ''
    if (!id || !sender || !recipient || !text) return []
    const isFromMe = Boolean(accountId && sender === accountId)
    return [{ schemaVersion: 1, id, channel: 'twitter', from: sender, to: recipient, content: text, timestamp: typeof item.created_timestamp === 'string' ? Number(item.created_timestamp) : Date.now(), type: 'text', isFromMe, providerEventId: id, actor: isFromMe ? 'owner' : 'customer', businessId: process.env.AICA_BUSINESS_ID || 'local-business', channelAccountId: accountId || recipient, conversationId: `twitter:${isFromMe ? recipient : sender}`, rawPayload: event }]
  })
}

export class XDirectMessageTransport {
  constructor(private readonly credentials: XUserContext) {}
  async sendText(recipientId: string, text: string): Promise<{ success: boolean; providerMessageId?: string; error?: string }> {
    if (!recipientId || !text || text.length > 10_000) return { success: false, error: 'X DM recipient/text is invalid or exceeds 10,000 characters' }
    const url = 'https://api.x.com/1.1/direct_messages/events/new.json'
    try {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: oauthHeader('POST', url, this.credentials), 'Content-Type': 'application/json' }, body: JSON.stringify({ event: { type: 'message_create', message_create: { target: { recipient_id: recipientId }, message_data: { text } } } }) })
      const data = await response.json().catch(() => ({})) as { event?: { id?: string }; errors?: Array<{ message?: string }> }
      if (!response.ok) return { success: false, error: data.errors?.[0]?.message || `X API request failed (${response.status})` }
      return { success: true, providerMessageId: data.event?.id }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
}
