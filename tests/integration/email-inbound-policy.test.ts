import { describe, expect, it } from 'vitest'
import { isGmailAuthFailure, shouldProcessEmailInbound } from '../../src/main/services/EmailInboundPolicy'

describe('email inbound policy', () => {
  const now = 2_000_000_000
  it('rejects self, stale, and already handled messages', () => {
    expect(shouldProcessEmailInbound({ isFromMe: true, timestamp: now }, undefined, now)).toBe(false)
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now - 60 * 60 * 1000 - 1 }, undefined, now)).toBe(false)
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now }, { replied: true }, now)).toBe(false)
  })

  it('rejects auto-generated and mailing-list messages', () => {
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now }, { headers: { 'auto-submitted': 'auto-generated' } }, now)).toBe(false)
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now }, { 'list-id': '<news.example>' }, now)).toBe(false)
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now }, { precedence: 'bulk' }, now)).toBe(false)
  })

  it('allows a recent human email and Auto-Submitted: no', () => {
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now }, { headers: { 'auto-submitted': 'no' } }, now)).toBe(true)
  })

  it('rejects delivery bounces before agent processing', () => {
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now, from: 'mailer-daemon@example.com', subject: 'Mail delivery failed' }, undefined, now)).toBe(false)
    expect(shouldProcessEmailInbound({ isFromMe: false, timestamp: now, from: 'postmaster@example.com', subject: 'Notice' }, { headers: { 'content-type': 'multipart/report' } }, now)).toBe(false)
  })

  it('classifies Gmail authorization failures for recovery messaging', () => {
    expect(isGmailAuthFailure(401)).toBe(true)
    expect(isGmailAuthFailure(403)).toBe(true)
    expect(isGmailAuthFailure(500)).toBe(false)
  })
})
