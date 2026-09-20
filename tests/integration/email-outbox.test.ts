import fs from 'node:fs'
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'

const dataDir = '/tmp/aica-email-outbox-test'
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
import { claimEmailSend, getEmailProviderMessageId, markEmailSent } from '../../src/main/services/EmailOutbox'

describe('email outbox', () => {
  beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }) })
  afterEach(() => vi.useRealTimers())
  it('claims an email once and suppresses replay after sent', () => {
    const payload = { to: 'customer@example.com', subject: 'Re: Help', body: 'Answer' }
    expect(claimEmailSend('key-1', payload)).toBe('claimed')
    expect(claimEmailSend('key-1', payload)).toBe('inflight')
    markEmailSent('key-1', '<provider-1>')
    expect(claimEmailSend('key-1', payload)).toBe('sent')
    expect(getEmailProviderMessageId('key-1')).toBe('<provider-1>')
  })

  it('reclaims a sending lease after a restart-sized timeout', () => {
    const payload = { to: 'customer@example.com', subject: 'Re: Help', body: 'Answer' }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
    expect(claimEmailSend('key-restart', payload)).toBe('claimed')
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(claimEmailSend('key-restart', payload)).toBe('claimed')
  })
})
