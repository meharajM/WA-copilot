import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/aica-webhook-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn() }
}))
vi.mock('electron-store', () => ({
  default: class TestStore {
    private values = new Map<string, unknown>()
    constructor(options?: { defaults?: Record<string, unknown> }) { for (const [key, value] of Object.entries(options?.defaults || {})) this.values.set(key, value) }
    get(key: string) { return this.values.get(key) }
    set(key: string, value: unknown) { this.values.set(key, value) }
  }
}))

import { whatsAppCloudWebhookServer } from '../../src/main/services/WhatsAppCloudWebhookServer'

describe('WhatsApp Cloud webhook server', () => {
  it('authenticates verification and event delivery', async () => {
    const old = { transport: process.env.WHATSAPP_TRANSPORT, token: process.env.WHATSAPP_CLOUD_VERIFY_TOKEN, secret: process.env.WHATSAPP_CLOUD_APP_SECRET, port: process.env.WHATSAPP_CLOUD_WEBHOOK_PORT }
    process.env.WHATSAPP_TRANSPORT = 'cloud'
    process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = 'verify-me'
    process.env.WHATSAPP_CLOUD_APP_SECRET = 'app-secret'
    process.env.WHATSAPP_CLOUD_WEBHOOK_PORT = '18787'
    try {
      const settings = new (await import('electron-store')).default<Record<string, unknown>>({ name: 'aica-store', defaults: {} })
      settings.set('whatsapp_transport', 'cloud')
      await whatsAppCloudWebhookServer.start()
      const challenge = await fetch('http://127.0.0.1:18787/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc')
      expect(await challenge.text()).toBe('abc')

      const body = JSON.stringify({ entry: [] })
      const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`
      const rejected = await fetch('http://127.0.0.1:18787/', { method: 'POST', body })
      expect(rejected.status).toBe(401)
      const accepted = await fetch('http://127.0.0.1:18787/', { method: 'POST', body, headers: { 'x-hub-signature-256': signature } })
      expect(accepted.status).toBe(200)
      expect(await accepted.text()).toBe('EVENT_RECEIVED')
      const oversized = await fetch('http://127.0.0.1:18787/', { method: 'POST', body: 'x'.repeat(1_000_001) })
      expect(oversized.status).toBe(413)

      const eventBody = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '1555' }, messages: [{ id: 'duplicate-cloud-1', from: '1999', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello' } }] } }] }] })
      const eventSignature = `sha256=${createHmac('sha256', 'app-secret').update(eventBody).digest('hex')}`
      for (let i = 0; i < 2; i++) await fetch('http://127.0.0.1:18787/', { method: 'POST', body: eventBody, headers: { 'x-hub-signature-256': eventSignature } })
      await new Promise(resolve => setTimeout(resolve, 10))
      const db = new Database('/tmp/aica-webhook-test/autonomy.db', { readonly: true })
      expect((db.prepare('SELECT COUNT(*) AS count FROM inbound_events WHERE id = ?').get('duplicate-cloud-1') as { count: number }).count).toBe(1)
      db.close()
    } finally {
      await whatsAppCloudWebhookServer.stop()
      if (old.transport === undefined) delete process.env.WHATSAPP_TRANSPORT; else process.env.WHATSAPP_TRANSPORT = old.transport
      if (old.token === undefined) delete process.env.WHATSAPP_CLOUD_VERIFY_TOKEN; else process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = old.token
      if (old.secret === undefined) delete process.env.WHATSAPP_CLOUD_APP_SECRET; else process.env.WHATSAPP_CLOUD_APP_SECRET = old.secret
      if (old.port === undefined) delete process.env.WHATSAPP_CLOUD_WEBHOOK_PORT; else process.env.WHATSAPP_CLOUD_WEBHOOK_PORT = old.port
    }
  })
})
