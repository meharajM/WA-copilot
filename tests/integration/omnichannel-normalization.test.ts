import { describe, expect, it } from 'vitest'
import { getChannelCapabilities, isValidNormalizedChannelMessage, normalizeEmailMessage } from '../../src/main/packages/omnichannel'

describe('shared channel normalization', () => {
  it('preserves email identity and thread headers', () => {
    expect(normalizeEmailMessage({ id: 'email-1', from: 'customer@example.com', to: 'support@example.com', subject: 'Question', body: 'Hello', timestamp: 123, messageId: '<m1>', inReplyTo: '<m0>', references: '<m0>', isFromMe: false })).toMatchObject({
      schemaVersion: 1, channel: 'email', content: 'Hello', subject: 'Question', messageId: '<m1>', inReplyTo: '<m0>', references: '<m0>', providerEventId: '<m1>', conversationId: '<m0>', actor: 'customer'
    })
  })

  it('preserves attachment metadata without embedding file content', () => {
    expect(normalizeEmailMessage({ id: 'email-2', from: 'customer@example.com', to: 'support@example.com', subject: 'Invoice', body: 'See attached', timestamp: 123, isFromMe: false, attachments: [{ id: 'att-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: 42 }] })).toMatchObject({
      attachments: [{ id: 'att-1', name: 'invoice.pdf', mimeType: 'application/pdf', size: 42 }]
    })
  })

  it('exposes conservative channel capability policy', () => {
    expect(getChannelCapabilities('email')).toMatchObject({ responseWindowMs: null, supportsTemplates: false, supportsIdempotency: true })
    expect(getChannelCapabilities('instagram')).toMatchObject({ responseWindowMs: 24 * 60 * 60 * 1000, maxTextLength: 2000, supportsDeliveryReceipts: true })
    expect(getChannelCapabilities('messenger')).toMatchObject({ responseWindowMs: 24 * 60 * 60 * 1000, maxTextLength: 2000, supportsDeliveryReceipts: true })
    expect(getChannelCapabilities('twitter').supportsDeliveryReceipts).toBe(false)
    expect(getChannelCapabilities('web').supportsIdempotency).toBe(false)
  })

  it('rejects normalized events without scoped identity fields', () => {
    expect(isValidNormalizedChannelMessage({ schemaVersion: 1, id: 'm-1', channel: 'email', businessId: 'business-1', channelAccountId: 'support@example.com', from: 'customer@example.com', to: 'support@example.com', content: '', timestamp: 123, type: 'text', isFromMe: false, conversationId: 'thread-1' })).toBe(true)
    expect(isValidNormalizedChannelMessage({ schemaVersion: 1, id: 'm-2', channel: 'email', from: '', to: 'support@example.com', content: '', timestamp: 123, type: 'text', isFromMe: false })).toBe(false)
    expect(isValidNormalizedChannelMessage({ id: 'm-3', channel: 'email', from: 'customer@example.com', to: 'support@example.com', content: '', timestamp: 123, type: 'text', isFromMe: false })).toBe(false)
  })
})
