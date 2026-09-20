import { describe, expect, it } from 'vitest'
import {
  buildGmailQuery,
  decodeGmailBase64,
  extractGmailBody,
  extractGmailAttachments,
  toInboundGmailMessage,
} from '../../src/main/services/email-gmail'

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

describe('buildGmailQuery', () => {
  it('starts from recent mail on first sync', () => {
    expect(buildGmailQuery(0, false)).toBe('newer_than:1h')
  })

  it('adds after cursor and unread filter when configured', () => {
    expect(buildGmailQuery(1_720_000_000, true)).toBe('after:1720000000 is:unread')
  })
})

describe('decodeGmailBase64', () => {
  it('decodes url-safe Gmail payloads', () => {
    const encoded = encodeBase64Url('Hello Gmail')
    expect(decodeGmailBase64(encoded)).toBe('Hello Gmail')
  })
})

describe('extractGmailBody', () => {
  it('prefers nested text/plain parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: encodeBase64Url('Plain text body') },
            },
            {
              mimeType: 'text/html',
              body: { data: encodeBase64Url('<p>HTML body</p>') },
            },
          ],
        },
      ],
    }

    expect(extractGmailBody(payload)).toBe('Plain text body')
  })

  it('falls back to stripped html when plain text is unavailable', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: encodeBase64Url('<p>Hello <strong>team</strong><br>Need help</p>') },
        },
      ],
    }

    expect(extractGmailBody(payload)).toBe('Hello team\nNeed help')
  })
})

describe('toInboundGmailMessage', () => {
  it('marks sent mail as from me and preserves Gmail metadata', () => {
    const message = toInboundGmailMessage(
      {
        id: 'gmail-1',
        internalDate: '1720000000000',
        labelIds: ['INBOX', 'SENT'],
        payload: {
          headers: [
            { name: 'From', value: 'Owner <owner@example.com>' },
            { name: 'To', value: 'customer@example.com' },
            { name: 'Subject', value: 'Re: Support request' },
            { name: 'Message-Id', value: '<msg-1@example.com>' },
            { name: 'In-Reply-To', value: '<root@example.com>' },
            { name: 'References', value: '<root@example.com>' },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: encodeBase64Url('Reply body') },
            },
          ],
        },
      },
      'owner@example.com'
    )

    expect(message).toMatchObject({
      id: 'gmail-1',
      from: 'owner@example.com',
      to: 'customer@example.com',
      subject: 'Re: Support request',
      body: 'Reply body',
      timestamp: 1720000000000,
      messageId: '<msg-1@example.com>',
      inReplyTo: '<root@example.com>',
      references: '<root@example.com>',
      isFromMe: true,
    })
  })

  it('preserves bounded Gmail attachment metadata without downloading bytes', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { filename: 'guide.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-pdf', size: 3 } },
        { filename: 'guide.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-pdf', size: 3 } },
        { filename: 'notes.txt', mimeType: 'text/plain', body: { attachmentId: 'att-text', size: 12 } },
      ],
    }
    expect(extractGmailAttachments(payload)).toEqual([
      { id: 'att-pdf', name: 'guide.pdf', mimeType: 'application/pdf', size: 3 },
      { id: 'att-text', name: 'notes.txt', mimeType: 'text/plain', size: 12 },
    ])
    expect(toInboundGmailMessage({ id: 'gmail-attachments', payload: { ...payload, headers: [{ name: 'From', value: 'sender@example.com' }], parts: payload.parts } })?.attachments).toEqual([
      { id: 'att-pdf', name: 'guide.pdf', mimeType: 'application/pdf', size: 3 },
      { id: 'att-text', name: 'notes.txt', mimeType: 'text/plain', size: 12 },
    ])
  })
})
