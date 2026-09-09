import { describe, expect, it } from 'vitest'
import { classifyWhatsAppWebPage, normalizeWhatsAppWebDomMessage } from '../../src/main/services/WhatsAppWebConnector'

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
})
