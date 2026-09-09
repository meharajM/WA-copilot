import { describe, expect, it, vi } from 'vitest'
import { normalizeXDirectMessage, verifyXWebhookSignature, xCrcResponse, XDirectMessageTransport } from '../../src/main/services/XDirectMessages'

describe('X direct-message adapter', () => {
  it('normalizes inbound message_create events', () => {
    expect(normalizeXDirectMessage({ events: [{ id: 'x-1', type: 'message_create', created_timestamp: '123', message_create: { sender_id: 'customer', target: { recipient_id: 'owner' }, message_data: { text: 'What are your hours?' } } }] })[0]).toMatchObject({ channel: 'twitter', providerEventId: 'x-1', from: 'customer', to: 'owner', content: 'What are your hours?' })
  })

  it('marks configured-account echoes as owner takeover events for the customer thread', () => {
    const message = normalizeXDirectMessage({ events: [{ id: 'x-owner-1', type: 'message_create', message_create: { sender_id: 'owner', target: { recipient_id: 'customer' }, message_data: { text: 'I will take this' } } }] }, 'owner')[0]
    expect(message).toMatchObject({ isFromMe: true, actor: 'owner', conversationId: 'twitter:customer' })
  })

  it('uses OAuth1 user-context signing and preserves provider errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ errors: [{ message: 'rate limit' }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const transport = new XDirectMessageTransport({ consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as', accountId: 'owner' })
    expect((await transport.sendText('customer', 'hello')).error).toBe('rate limit')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^OAuth /)
    vi.unstubAllGlobals()
  })

  it('implements X CRC and webhook signature verification', () => {
    const response = xCrcResponse('crc-token', 'secret')
    expect(response.response_token).toMatch(/^sha256=/)
    expect(verifyXWebhookSignature('body', `sha256=${Buffer.from([]).toString('base64')}`, 'secret')).toBe(false)
  })
})
