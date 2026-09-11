import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { normalizeMetaDeliveryUpdates, normalizeMetaLeadEvents, normalizeMetaWebhook, verifyMetaWebhookSignature } from '../../src/main/services/MetaMessaging'

describe('Meta messaging adapter', () => {
  it('verifies signatures and normalizes Messenger events', () => {
    const raw = JSON.stringify({ entry: [{ messaging: [{ sender: { id: 'customer' }, recipient: { id: 'page' }, timestamp: 123, message: { mid: 'mid-1', text: 'What are your hours?' } }] }] })
    const signature = `sha256=${createHmac('sha256', 'secret').update(raw).digest('hex')}`
    expect(verifyMetaWebhookSignature(raw, signature, 'secret')).toBe(true)
    expect(normalizeMetaWebhook(JSON.parse(raw), 'messenger')[0]).toMatchObject({ id: 'mid-1', channel: 'messenger', providerEventId: 'mid-1', conversationId: 'messenger:customer', content: 'What are your hours?' })
  })

  it('escalates media as metadata without requiring binary retrieval', () => {
    const result = normalizeMetaWebhook({ entry: [{ messaging: [{ sender: { id: 'customer' }, recipient: { id: 'ig' }, message: { mid: 'mid-2', attachments: [{ type: 'image', payload: { url: 'https://example.test/image' } }] } }] }] }, 'instagram')
    expect(result[0]).toMatchObject({ channel: 'instagram', type: 'image', mediaUrl: 'https://example.test/image', content: '' })
  })

  it('records lead attribution without granting messaging consent', () => {
    expect(normalizeMetaLeadEvents({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-1', page_id: 'page-1', form_id: 'form-1', campaign_id: 'campaign-1' } }] }] })).toMatchObject([{ id: 'meta-lead:lead-1', source: 'meta-leadgen', pageId: 'page-1', formId: 'form-1', campaignId: 'campaign-1', messagingConsent: false }])
  })

  it('marks account echoes as owner messages for takeover handling', () => {
    const messages = normalizeMetaWebhook({ entry: [{ id: 'page', messaging: [{ sender: { id: 'page' }, recipient: { id: 'customer' }, message: { mid: 'mid-owner', text: 'I will take this' } }] }] }, 'messenger')
    expect(messages[0]).toMatchObject({ isFromMe: true, actor: 'owner' })
  })

  it('normalizes bounded delivery and read receipts', () => {
    const updates = normalizeMetaDeliveryUpdates({ entry: [{ messaging: [{ timestamp: 123, delivery: { mids: ['m-1'] }, read: { mids: ['m-2'] } }] }] }, 'instagram')
    expect(updates).toEqual([{ providerMessageId: 'm-1', status: 'delivered', timestamp: 123, channel: 'instagram' }, { providerMessageId: 'm-2', status: 'read', timestamp: 123, channel: 'instagram' }])
  })

  it('bounds sends and surfaces provider rate/server failures', async () => {
    const transport = new (await import('../../src/main/services/MetaMessaging')).MetaMessagingTransport({ accessToken: 'token', accountId: 'page' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) })
    vi.stubGlobal('fetch', fetchMock)
    expect((await transport.sendText('customer', 'hello')).error).toBe('rate limit')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await transport.sendText('', 'hello')).error).toMatch(/invalid/)
    expect((await transport.sendText('customer', 'x'.repeat(2001))).error).toMatch(/2,000/)
    vi.unstubAllGlobals()
  })
})
