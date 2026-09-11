import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { normalizeCloudDeliveryUpdates, normalizeCloudWebhook, verifyWebhookChallenge, verifyWebhookSignature } from '../../src/main/services/WhatsAppCloudWebhook'

describe('WhatsApp Cloud webhook', () => {
  it('verifies challenge and signed payloads', () => {
    const body = '{"entry":[]}'
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
    expect(verifyWebhookChallenge('subscribe', 'token', 'challenge', 'token')).toBe('challenge')
    expect(verifyWebhookSignature(body, signature, 'secret')).toBe(true)
    expect(verifyWebhookSignature(body, signature, 'wrong')).toBe(false)
  })

  it('normalizes inbound text and ignores delivery status events', () => {
    const result = normalizeCloudWebhook({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '1555' }, messages: [{ id: 'wamid.1', from: '1999', timestamp: '2', type: 'text', text: { body: 'Hi' } }] } }] }] })
    expect(result[0]).toMatchObject({ id: 'wamid.1', channel: 'whatsapp', from: '1999', to: '1555', content: 'Hi', timestamp: 2000, actor: 'customer', conversationId: 'whatsapp:1999', businessId: 'local-business' })
    expect(normalizeCloudWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1' }] } }] }] })).toEqual([])
    expect(normalizeCloudDeliveryUpdates({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '3', recipient_id: '1999' }] } }] }] }))
      .toEqual([{ providerMessageId: 'wamid.1', status: 'delivered', timestamp: 3000, recipient: '1999' }])
  })

  it('preserves media, replies, and owner echoes', () => {
    const result = normalizeCloudWebhook({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '1555' }, messages: [{ id: 'm1', from: '1555', timestamp: '2', type: 'image', image: { id: 'img1' }, context: { id: 'old' } }] } }] }] })
    expect(result[0]).toMatchObject({ type: 'image', mediaId: 'img1', replyToId: 'old', isFromMe: true, providerEventId: 'm1' })
  })
})
