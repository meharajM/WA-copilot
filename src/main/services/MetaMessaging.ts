import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ChannelMessage } from '../packages/omnichannel'

export type MetaMessagingChannel = 'instagram' | 'messenger'

export interface MetaMessagingConfig { accessToken: string; apiVersion?: string; accountId: string }
export interface MetaLeadEvent { id: string; source: 'meta-leadgen'; leadId: string; pageId?: string; formId?: string; adId?: string; campaignId?: string; messagingConsent: false; rawPayload: unknown }
export interface MetaDeliveryUpdate { providerMessageId: string; status: 'delivered' | 'read'; timestamp: number; channel: MetaMessagingChannel }

export function verifyMetaWebhookSignature(rawBody: string, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith('sha256=') || !appSecret) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const actual = signature.slice(7)
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export function normalizeMetaWebhook(payload: unknown, channel: MetaMessagingChannel): ChannelMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const entries = (payload as { entry?: unknown }).entry
  if (!Array.isArray(entries)) return []
  const messages: ChannelMessage[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const messaging = (entry as { messaging?: unknown }).messaging
    if (!Array.isArray(messaging)) continue
    for (const event of messaging) {
      if (!event || typeof event !== 'object') continue
      const item = event as Record<string, unknown>
      const accountId = typeof (entry as Record<string, unknown>).id === 'string' ? (entry as Record<string, unknown>).id as string : ''
      const sender = item.sender && typeof item.sender === 'object' ? item.sender as Record<string, unknown> : {}
      const recipient = item.recipient && typeof item.recipient === 'object' ? item.recipient as Record<string, unknown> : {}
      const message = item.message && typeof item.message === 'object' ? item.message as Record<string, unknown> : null
      const id = typeof message?.mid === 'string' ? message.mid : ''
      const from = typeof sender.id === 'string' ? sender.id : ''
      const to = typeof recipient.id === 'string' ? recipient.id : ''
      if (!id || !from || !to || !message) continue
      const text = typeof message.text === 'string' ? message.text : ''
      const attachments = Array.isArray(message.attachments) ? message.attachments : []
      if (!text && attachments.length === 0) continue
      const firstAttachment = attachments[0] && typeof attachments[0] === 'object' ? attachments[0] as Record<string, unknown> : undefined
      const type = firstAttachment?.type === 'image' || firstAttachment?.type === 'video' || firstAttachment?.type === 'audio' ? firstAttachment.type : text ? 'text' : 'document'
      const isFromMe = Boolean(accountId && from === accountId)
      messages.push({ schemaVersion: 1, id, channel, from, to, content: text, timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(), type, isFromMe, providerEventId: id, actor: isFromMe ? 'owner' : 'customer', businessId: process.env.AICA_BUSINESS_ID || 'local-business', channelAccountId: accountId || to, conversationId: `${channel}:${from}`, mediaUrl: typeof (firstAttachment?.payload as Record<string, unknown> | undefined)?.url === 'string' ? (firstAttachment?.payload as Record<string, unknown>).url as string : undefined, rawPayload: event })
    }
  }
  return messages
}

export function normalizeMetaLeadEvents(payload: unknown): MetaLeadEvent[] {
  if (!payload || typeof payload !== 'object') return []
  const entries = (payload as { entry?: unknown }).entry
  if (!Array.isArray(entries)) return []
  const leads: MetaLeadEvent[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const changes = (entry as { changes?: unknown }).changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      if (!change || typeof change !== 'object' || (change as { field?: unknown }).field !== 'leadgen') continue
      const value = (change as { value?: unknown }).value
      if (!value || typeof value !== 'object') continue
      const item = value as Record<string, unknown>
      const leadId = typeof item.leadgen_id === 'string' ? item.leadgen_id : ''
      const pageId = typeof item.page_id === 'string' ? item.page_id : undefined
      if (!leadId || !pageId) continue
      leads.push({ id: `meta-lead:${leadId}`, source: 'meta-leadgen', leadId, pageId, formId: typeof item.form_id === 'string' ? item.form_id : undefined, adId: typeof item.ad_id === 'string' ? item.ad_id : undefined, campaignId: typeof item.campaign_id === 'string' ? item.campaign_id : undefined, messagingConsent: false, rawPayload: change })
    }
  }
  return leads
}

export function normalizeMetaDeliveryUpdates(payload: unknown, channel: MetaMessagingChannel): MetaDeliveryUpdate[] {
  if (!payload || typeof payload !== 'object') return []
  const updates: MetaDeliveryUpdate[] = []
  for (const entry of (payload as { entry?: unknown[] }).entry ?? []) {
    for (const event of ((entry as { messaging?: unknown[] }).messaging ?? [])) {
      if (!event || typeof event !== 'object') continue
      const item = event as Record<string, unknown>
      const timestamp = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) ? item.timestamp : Date.now()
      for (const kind of ['delivery', 'read'] as const) {
        const receipt = item[kind]
        if (!receipt || typeof receipt !== 'object') continue
        const mids = (receipt as { mids?: unknown }).mids
        if (!Array.isArray(mids)) continue
        for (const id of mids) if (typeof id === 'string' && id) updates.push({ providerMessageId: id, status: kind === 'read' ? 'read' : 'delivered', timestamp, channel })
      }
    }
  }
  return updates
}

export class MetaMessagingTransport {
  constructor(private readonly config: MetaMessagingConfig) {}

  async sendText(recipientId: string, text: string): Promise<{ success: boolean; providerMessageId?: string; error?: string }> {
    if (!recipientId.trim() || !text.trim() || text.length > 2000) return { success: false, error: 'Meta message recipient/text is invalid or exceeds 2,000 characters' }
    try {
      const response = await fetch(`https://graph.facebook.com/${this.config.apiVersion || 'v23.0'}/${this.config.accountId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }) })
      const data = await response.json().catch(() => ({})) as { message_id?: string; error?: { message?: string } }
      if (!response.ok) return { success: false, error: data.error?.message || `Meta Graph API request failed (${response.status})` }
      if (!data.message_id) return { success: false, error: 'Meta Graph API response did not include a message ID' }
      return { success: true, providerMessageId: data.message_id }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
}
