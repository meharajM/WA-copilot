import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MetaWebhookServer } from '../../src/main/services/MetaWebhookServer'

describe('Meta webhook server', () => {
  it('verifies GET and POST events before forwarding normalized messages', async () => {
    const messages: unknown[] = []
    const leads: unknown[] = []
    const deliveries: unknown[] = []
    const server = new MetaWebhookServer(message => messages.push(message), lead => leads.push(lead), update => deliveries.push(update))
    await server.start('messenger', 'verify', 'secret', 0)
    const address = server.address()!
    const base = `http://${address}`
    expect((await fetch(`${base}/?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=ok`)).status).toBe(200)
    const payload = { entry: [{ messaging: [{ sender: { id: 'c' }, recipient: { id: 'p' }, timestamp: 1, message: { mid: 'm', text: 'Hello' } }, { timestamp: 2, delivery: { mids: ['m'] } }] }] }
    const body = JSON.stringify(payload)
    const response = await fetch(base, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}` }, body })
    expect(response.status).toBe(200)
    expect(messages).toHaveLength(1)
    expect(leads).toHaveLength(0)
    expect(deliveries).toEqual([{ providerMessageId: 'm', status: 'delivered', timestamp: 2, channel: 'messenger' }])
    await server.stop()
  })
})
