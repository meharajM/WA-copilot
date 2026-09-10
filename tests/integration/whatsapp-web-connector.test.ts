import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/main/services/playwright/BrowserManager', () => ({ BrowserManager: class { private readonly page = { goto: vi.fn(), isClosed: () => false, locator: () => ({ count: async () => 0 }), url: () => 'https://web.whatsapp.com/' }; async getPage() { return this.page }; getCurrentPage() { return this.page }; async close() {}; async surfaceBrowser() {} } }))
import { classifyWhatsAppWebPage, normalizeWhatsAppWebDomMessage } from '../../src/main/services/WhatsAppWebConnector'
import { WhatsAppWebConnector } from '../../src/main/services/WhatsAppWebConnector'

describe('WhatsApp Web connector state', () => {
  it('classifies manual QR, connected and logged-out states', () => {
    expect(classifyWhatsAppWebPage(true, 'https://web.whatsapp.com/')).toBe('qr_required')
    expect(classifyWhatsAppWebPage(false, 'https://web.whatsapp.com/')).toBe('connected')
    expect(classifyWhatsAppWebPage(false, 'https://web.whatsapp.com/auth')).toBe('logged_out')
  })

  it('normalizes only non-empty incoming DOM messages', () => {
    expect(normalizeWhatsAppWebDomMessage('false_1', '  Hello  ', '15551234567')).toMatchObject({ id: 'false_1', content: 'Hello', from: '15551234567', isFromMe: false })
    expect(normalizeWhatsAppWebDomMessage('', 'Hello', 'chat')).toBeNull()
  })

  it('returns the initial page classification and starts health monitoring', async () => {
    const connector = new WhatsAppWebConnector()
    await expect(connector.start()).resolves.toMatchObject({ status: 'connected', lastHealthCheck: expect.any(Number) })
    await connector.stop()
  })
})
