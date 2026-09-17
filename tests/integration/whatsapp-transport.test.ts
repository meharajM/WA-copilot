import { describe, expect, it, vi } from 'vitest'
import { allowsBaileysDirectSend, allowsBaileysInbound } from '../../src/main/services/WhatsAppTransportPolicy'
import { WhatsAppCloudApiTransport } from '../../src/main/services/WhatsAppCloudApiTransport'

describe('WhatsApp outbound transport contract', () => {
  it('returns provider IDs from the Cloud transport contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.transport' }] }), { status: 200 }))
    const result = await new WhatsAppCloudApiTransport({ phoneNumberId: 'phone', apiVersion: 'v1', accessToken: 'token' }).sendText('1999', 'Hello')
    expect(result).toEqual({ providerMessageId: 'wamid.transport' })
    fetchMock.mockRestore()
  })

  it('blocks legacy Baileys sends for Cloud/Web selections', () => {
    expect(allowsBaileysDirectSend('baileys')).toBe(true)
    expect(allowsBaileysDirectSend('cloud')).toBe(false)
    expect(allowsBaileysDirectSend('web')).toBe(false)
  })

  it('blocks Baileys inbound autonomy when another transport is selected', () => {
    expect(allowsBaileysInbound('baileys')).toBe(true)
    expect(allowsBaileysInbound('cloud')).toBe(false)
    expect(allowsBaileysInbound('web')).toBe(false)
  })
})
