import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { XWebhookServer } from '../../src/main/services/XWebhookServer'

describe('X webhook server', () => {
  it('answers CRC and forwards signed DM events', async () => {
    const messages: unknown[] = []
    const server = new XWebhookServer(message => messages.push(message))
    await server.start('secret', 0)
    const base = `http://${server.address()}`
    expect((await fetch(`${base}/?crc_token=token`)).status).toBe(200)
    const body = JSON.stringify({ events: [{ id: 'x-event', type: 'message_create', message_create: { sender_id: 'customer', target: { recipient_id: 'owner' }, message_data: { text: 'Hello' } } }] })
    expect((await fetch(base, { method: 'POST', headers: { 'x-twitter-webhooks-signature': `sha256=${createHmac('sha256', 'secret').update(body).digest('base64')}` }, body })).status).toBe(200)
    expect(messages).toHaveLength(1)
    expect((await fetch(base, { method: 'POST', body: 'x'.repeat(1_000_001) })).status).toBe(413)
    await server.stop()
  })
})
