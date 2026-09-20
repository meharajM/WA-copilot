import { describe, expect, it } from 'vitest'
import { normalizeBrowserWhatsAppEvent } from '../../src/renderer/src/hooks/useWhatsAppBridge'

describe('browser WhatsApp inbound normalization', () => {
  it('normalizes bounded text payloads and converts second timestamps', () => {
    expect(normalizeBrowserWhatsAppEvent({
      id: 1,
      providerEventId: 'wa-1',
      conversationId: '15551234567',
      payload: { from: '+1 555 123 4567', text: 'Need order help', timestamp: 1_700_000_000, type: 'text' },
      status: 'draft',
      createdAt: 1_700_000_100_000,
    })).toEqual({
      id: 'wa-1',
      from: '+1 555 123 4567',
      content: 'Need order help',
      type: 'text',
      timestamp: 1_700_000_000_000,
      isFromMe: false,
      conversationId: '15551234567',
    })
  })

  it('accepts nested provider messages and skips empty payloads', () => {
    expect(normalizeBrowserWhatsAppEvent({
      id: 2,
      providerEventId: 'wa-2',
      conversationId: 'chat-2',
      payload: { message: { body: 'Nested message', isFromMe: true }, sender: 'customer' },
      status: 'draft',
      createdAt: 42,
    })).toMatchObject({ content: 'Nested message', isFromMe: true, from: 'customer' })
    expect(normalizeBrowserWhatsAppEvent({
      id: 3,
      providerEventId: 'wa-3',
      conversationId: 'chat-3',
      payload: {},
      status: 'draft',
      createdAt: 42,
    })).toBeNull()
  })

  it('normalizes media-only payloads into bounded attachment metadata', () => {
    expect(normalizeBrowserWhatsAppEvent({
      id: 4,
      providerEventId: 'baileys:media-4',
      conversationId: 'chat-4',
      payload: {
        from: '15551234567',
        type: 'image',
        media: { type: 'image', fileName: 'photo.jpg', mimeType: 'image/jpeg', size: 1234 },
        timestamp: 1_700_000_000,
      },
      status: 'draft',
      createdAt: 42,
    })).toMatchObject({
      content: '[WhatsApp image attachment]',
      type: 'image',
      mediaName: 'photo.jpg',
      mediaMimeType: 'image/jpeg',
      mediaSize: 1234,
    })
  })
})
