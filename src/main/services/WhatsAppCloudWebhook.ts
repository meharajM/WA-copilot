import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ChannelMessage } from '../packages/omnichannel'

export function verifyWebhookChallenge(mode: unknown, token: unknown, challenge: unknown, expectedToken: string): string | null {
  return mode === 'subscribe' && token === expectedToken && typeof challenge === 'string' ? challenge : null
}

export function verifyWebhookSignature(rawBody: string, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`)
  const received = Buffer.from(signature)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

export function normalizeCloudWebhook(payload: unknown): ChannelMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const entries = (payload as { entry?: unknown[] }).entry
  if (!Array.isArray(entries)) return []
  const messages: ChannelMessage[] = []
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const value = (change as { value?: { metadata?: { display_phone_number?: string }; messages?: unknown[] } })?.value
      const businessNumber = value?.metadata?.display_phone_number || ''
      for (const raw of value?.messages ?? []) {
        const item = raw as { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; image?: { id?: string; caption?: string }; document?: { id?: string; caption?: string }; video?: { id?: string; caption?: string }; audio?: { id?: string }; context?: { id?: string } }
        if (!item.id || !item.from || !item.timestamp) continue
        const timestamp = Number(item.timestamp) * 1000
        if (!Number.isFinite(timestamp) || timestamp <= 0) continue
        const type = ['image', 'video', 'document', 'audio'].includes(item.type || '') ? item.type as ChannelMessage['type'] : 'text'
        const media = item.image || item.document || item.video || item.audio
        const content = item.text?.body || ('caption' in (media || {}) ? (media as { caption?: string }).caption || '' : '')
        messages.push({
          id: item.id,
          channel: 'whatsapp',
          from: item.from,
          to: businessNumber,
          content,
          timestamp,
          type,
          isFromMe: Boolean(businessNumber && item.from === businessNumber),
          mediaId: (media as { id?: string } | undefined)?.id,
          replyToId: item.context?.id,
          providerEventId: item.id,
          businessId: process.env.AICA_BUSINESS_ID || 'local-business',
          channelAccountId: (value as { metadata?: { phone_number_id?: string } } | undefined)?.metadata?.phone_number_id || businessNumber,
          actor: businessNumber && item.from === businessNumber ? 'owner' : 'customer',
          conversationId: `whatsapp:${item.from}`,
          rawPayload: raw
        })
      }
    }
  }
  return messages
}

export interface CloudDeliveryUpdate {
  providerMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: number
  recipient: string
}

export function normalizeCloudDeliveryUpdates(payload: unknown): CloudDeliveryUpdate[] {
  if (!payload || typeof payload !== 'object') return []
  const updates: CloudDeliveryUpdate[] = []
  for (const entry of (payload as { entry?: unknown[] }).entry ?? []) {
    for (const change of (entry as { changes?: unknown[] }).changes ?? []) {
      for (const raw of ((change as { value?: { statuses?: unknown[] } }).value?.statuses ?? [])) {
        const item = raw as { id?: string; status?: string; timestamp?: string; recipient_id?: string }
        const timestamp = Number(item.timestamp) * 1000
        if (!item.id || !item.recipient_id || !Number.isFinite(timestamp) || timestamp <= 0) continue
        if (!['sent', 'delivered', 'read', 'failed'].includes(item.status || '')) continue
        updates.push({ providerMessageId: item.id, status: item.status as CloudDeliveryUpdate['status'], timestamp, recipient: item.recipient_id })
      }
    }
  }
  return updates
}
