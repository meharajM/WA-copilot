import { describe, expect, it, vi } from 'vitest'
import { WhatsAppCloudApiTransport } from '../../src/main/services/WhatsAppCloudApiTransport'

describe('WhatsApp Cloud API transport', () => {
  it('sends a text payload and returns the provider ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }))
    const result = await new WhatsAppCloudApiTransport({ phoneNumberId: 'phone-1', accessToken: 'secret', apiVersion: 'v1' }).sendText('9199', 'Hello')
    expect(result.providerMessageId).toBe('wamid.1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ type: 'text', to: '9199' })
    fetchMock.mockRestore()
  })

  it('fails closed on provider errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 401 }))
    await expect(new WhatsAppCloudApiTransport({ phoneNumberId: 'phone-1', accessToken: 'secret', apiVersion: 'v1' }).sendTemplate('9199', 'support_followup', 'en_US'))
      .rejects.toThrow('Invalid token')
    fetchMock.mockRestore()
  })

  it('fails closed when the access token has expired', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Access token has expired' } }), { status: 401 }))
    await expect(new WhatsAppCloudApiTransport({ phoneNumberId: 'phone-1', accessToken: 'expired', apiVersion: 'v1' }).sendText('9199', 'Hello'))
      .rejects.toThrow('Access token has expired')
    fetchMock.mockRestore()
  })

  it('builds an approved template payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.template' }] }), { status: 200 }))
    await new WhatsAppCloudApiTransport({ phoneNumberId: 'phone-1', accessToken: 'secret', apiVersion: 'v1' }).sendTemplate('9199', 'support_followup', 'en_US', ['Alice'])
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ type: 'template', template: { name: 'support_followup', language: { code: 'en_US' } } })
    fetchMock.mockRestore()
  })

  it('preserves rate-limit and server-error signals for host classification', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Temporary outage' } }), { status: 503 }))
    const transport = new WhatsAppCloudApiTransport({ phoneNumberId: 'phone-1', accessToken: 'secret', apiVersion: 'v1' })
    await expect(transport.sendText('9199', 'Hello')).rejects.toThrow('Rate limit reached')
    await expect(transport.sendText('9199', 'Hello')).rejects.toThrow('Temporary outage')
    fetchMock.mockRestore()
  })
})
