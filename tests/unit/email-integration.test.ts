import { describe, expect, it } from 'vitest'
import {
  generateEmailSessionKey,
  normalizeSubject,
  normalizeEmailAddress,
  convertEmailToLLMMessage,
  getEmailSystemPrompt,
  generateEmailSessionTitle,
  isValidEmailAddress,
  validateEmailMessage,
  EMAIL_CHANNEL_PREFIX,
  type EmailMessage,
} from '../../src/renderer/src/lib/email-integration'

// ── Test Helpers ──────────────────────────────────────────────────────────────

function createMockEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'email_001',
    from: 'customer@example.com',
    to: 'support@business.com',
    subject: 'Help with my order',
    body: 'Hi, I need help with order #12345. It has not arrived yet.',
    bodyType: 'text',
    messageId: '<msg001@mail.example.com>',
    timestamp: Date.now(),
    isFromMe: false,
    ...overrides,
  }
}

// ── Session Key Generation ────────────────────────────────────────────────────

describe('generateEmailSessionKey', () => {
  it('creates deterministic key for new thread using Message-ID', () => {
    const email = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order inquiry',
      messageId: '<abc123@mail.example.com>',
    })

    const key = generateEmailSessionKey(email)

    expect(key.sender).toBe('alice@example.com')
    expect(key.key).toBe(`${EMAIL_CHANNEL_PREFIX}::alice@example.com::abc123`)
    expect(key.threadId).toBe('abc123')
  })

  it('uses References root for deep thread continuity', () => {
    const email = createMockEmail({
      from: 'alice@example.com',
      subject: 'Re: Re: Order inquiry',
      inReplyTo: '<mid002@mail.example.com>',
      references: '<root001@mail.example.com> <mid002@mail.example.com>',
      messageId: '<mid003@mail.example.com>',
    })

    const key = generateEmailSessionKey(email)

    // Should use the root of References chain
    expect(key.threadId).toBe('root001')
    expect(key.key).toContain('root001')
  })

  it('uses In-Reply-To when no References header exists', () => {
    const email = createMockEmail({
      from: 'alice@example.com',
      subject: 'Re: Order inquiry',
      inReplyTo: '<parent456@mail.example.com>',
      messageId: '<reply789@mail.example.com>',
    })

    const key = generateEmailSessionKey(email)

    expect(key.threadId).toBe('parent456')
    expect(key.key).toContain('parent456')
  })

  it('falls back to subject hash when no threading headers exist', () => {
    const email = createMockEmail({
      from: 'bob@example.com',
      subject: 'Brand new topic',
      messageId: undefined,
      inReplyTo: undefined,
      references: undefined,
    })

    const key = generateEmailSessionKey(email)

    expect(key.threadId).toMatch(/^subj_[a-z0-9]+$/)
    expect(key.sender).toBe('bob@example.com')
  })

  it('normalizes sender email to lowercase', () => {
    const email = createMockEmail({
      from: 'Alice@Example.COM',
    })

    const key = generateEmailSessionKey(email)

    expect(key.sender).toBe('alice@example.com')
    expect(key.key).toContain('alice@example.com')
  })

  it('extracts bare address from display name format', () => {
    const email = createMockEmail({
      from: 'John Doe <john@example.com>',
    })

    const key = generateEmailSessionKey(email)

    expect(key.sender).toBe('john@example.com')
  })
})

// ── Subject Normalization ─────────────────────────────────────────────────────

describe('normalizeSubject', () => {
  it('strips Re: prefix', () => {
    expect(normalizeSubject('Re: Meeting tomorrow')).toBe('Meeting tomorrow')
  })

  it('strips Fwd: prefix', () => {
    expect(normalizeSubject('Fwd: Project update')).toBe('Project update')
  })

  it('strips FW: prefix', () => {
    expect(normalizeSubject('FW: Invoice #999')).toBe('Invoice #999')
  })

  it('strips multiple nested prefixes', () => {
    expect(normalizeSubject('Re: Re: Fwd: Original Subject')).toBe('Original Subject')
  })

  it('handles German prefixes (AW:, WG:)', () => {
    expect(normalizeSubject('AW: Bestellung')).toBe('Bestellung')
    expect(normalizeSubject('WG: Anfrage')).toBe('Anfrage')
  })

  it('handles Swedish prefix (SV:)', () => {
    expect(normalizeSubject('SV: Mötesanteckningar')).toBe('Mötesanteckningar')
  })

  it('returns unchanged subject with no prefix', () => {
    expect(normalizeSubject('Plain subject')).toBe('Plain subject')
  })

  it('trims whitespace', () => {
    expect(normalizeSubject('  Re: Hello  ')).toBe('Hello')
  })

  it('handles prefix with no space after colon', () => {
    expect(normalizeSubject('Re:No subject')).toBe('No subject')
  })
})

// ── Email Address Normalization ───────────────────────────────────────────────

describe('normalizeEmailAddress', () => {
  it('lowercases the address', () => {
    expect(normalizeEmailAddress('USER@EXAMPLE.COM')).toBe('user@example.com')
  })

  it('trims whitespace', () => {
    expect(normalizeEmailAddress('  user@example.com  ')).toBe('user@example.com')
  })

  it('extracts address from display name format', () => {
    expect(normalizeEmailAddress('John Doe <john@example.com>')).toBe('john@example.com')
  })

  it('handles bare address', () => {
    expect(normalizeEmailAddress('user@example.com')).toBe('user@example.com')
  })

  it('returns empty string for empty input', () => {
    expect(normalizeEmailAddress('')).toBe('')
    expect(normalizeEmailAddress(undefined as unknown as string)).toBe('')
  })
})

// ── LLM Message Conversion ────────────────────────────────────────────────────

describe('convertEmailToLLMMessage', () => {
  it('converts plain text email to LLM message with headers', async () => {
    const email = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order status',
      body: 'Where is my order?',
      bodyType: 'text',
    })

    const llmMsg = convertEmailToLLMMessage(email)

    expect(llmMsg.role).toBe('user')
    // Multiple parts are returned as array (header + body)
    const content = typeof llmMsg.content === 'string' ? llmMsg.content : (llmMsg.content as Array<{ text: string }>).map(p => p.text).join('')
    expect(content).toContain('From: alice@example.com')
    expect(content).toContain('Subject: Order status')
    expect(content).toContain('Where is my order?')
  })

  it('strips HTML tags from HTML body', async () => {
    const email = createMockEmail({
      body: '<html><body><p>Hello <b>world</b></p></body></html>',
      bodyType: 'html',
    })

    const llmMsg = convertEmailToLLMMessage(email)

    const content = typeof llmMsg.content === 'string' ? llmMsg.content : (llmMsg.content as Array<{ text: string }>).map(p => p.text).join('')
    expect(content).toContain('Hello world')
    expect(content).not.toContain('<html>')
    expect(content).not.toContain('<b>')
  })

  it('includes attachment metadata', async () => {
    const email = createMockEmail({
      attachments: [
        { filename: 'invoice.pdf', contentType: 'application/pdf', size: 204800, path: '/tmp/invoice.pdf' },
      ],
    })

    const llmMsg = convertEmailToLLMMessage(email)

    const content = typeof llmMsg.content === 'string' ? llmMsg.content : (llmMsg.content as Array<{ text: string }>).map(p => p.text).join('')
    expect(content).toContain('[ATTACHMENTS]')
    expect(content).toContain('invoice.pdf')
    expect(llmMsg.attachments).toBeDefined()
    expect(llmMsg.attachments?.length).toBe(1)
    expect(llmMsg.attachments?.[0].name).toBe('invoice.pdf')
  })

  it('forwards bounded browser image bytes when Gmail attachment hydration succeeds', () => {
    const llmMsg = convertEmailToLLMMessage(createMockEmail({
      attachments: [{ filename: 'photo.jpg', contentType: 'image/jpeg', size: 3, dataUrl: 'data:image/jpeg;base64,AQID' }],
    }))
    expect(llmMsg.attachments).toEqual([{
      name: 'photo.jpg', path: '', type: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AQID',
    }])
  })

  it('adds threading context when In-Reply-To is present', async () => {
    const email = createMockEmail({
      inReplyTo: '<parent@mail.example.com>',
    })

    const llmMsg = convertEmailToLLMMessage(email)

    const content = typeof llmMsg.content === 'string' ? llmMsg.content : (llmMsg.content as Array<{ text: string }>).map(p => p.text).join('')
    expect(content).toContain('ongoing thread')
  })

  it('normalizes subject in the header block', async () => {
    const email = createMockEmail({
      subject: 'Re: Fwd: Order status',
    })

    const llmMsg = convertEmailToLLMMessage(email)

    const content = typeof llmMsg.content === 'string' ? llmMsg.content : (llmMsg.content as Array<{ text: string }>).map(p => p.text).join('')
    expect(content).toContain('Subject: Order status')
    expect(content).not.toContain('Re:')
    expect(content).not.toContain('Fwd:')
  })
})

// ── Email System Prompt ───────────────────────────────────────────────────────

describe('getEmailSystemPrompt', () => {
  it('returns system message with email support instructions', () => {
    const prompt = getEmailSystemPrompt()

    expect(prompt.role).toBe('system')
    expect(prompt.content).toContain('EMAIL CUSTOMER SUPPORT MODE ACTIVE')
    expect(prompt.content).toContain('THREAD AWARENESS')
    expect(prompt.content).toContain('EMAIL FORMATTING RULES')
    expect(prompt.content).toContain('STRICT GROUNDING RULES')
    expect(prompt.content).toContain('ESCALATION')
  })

  it('includes business name from persona', () => {
    const prompt = getEmailSystemPrompt({ name: 'Acme Corp', tone: 'friendly' })

    expect(prompt.content).toContain('Acme Corp')
    expect(prompt.content).toContain('friendly')
  })

  it('uses defaults when no persona provided', () => {
    const prompt = getEmailSystemPrompt()

    expect(prompt.content).toContain('Our Business')
    expect(prompt.content).toContain('professional')
  })
})

// ── Session Title Generation ──────────────────────────────────────────────────

describe('generateEmailSessionTitle', () => {
  it('uses normalized subject as title', () => {
    const title = generateEmailSessionTitle({
      subject: 'Re: Order #12345',
      from: 'alice@example.com',
    })

    expect(title).toBe('Order #12345')
  })

  it('truncates long subjects', () => {
    const longSubject = 'This is a very long email subject line that should be truncated in the sidebar for readability'
    const title = generateEmailSessionTitle({
      subject: longSubject,
      from: 'alice@example.com',
    })

    expect(title.length).toBeLessThanOrEqual(50)
    expect(title.endsWith('...')).toBe(true)
  })

  it('falls back to sender when subject is empty', () => {
    const title = generateEmailSessionTitle({
      subject: '',
      from: 'alice@example.com',
    })

    expect(title).toBe('Email from alice@example.com')
  })
})

// ── Email Validation ──────────────────────────────────────────────────────────

describe('isValidEmailAddress', () => {
  it('accepts valid email addresses', () => {
    expect(isValidEmailAddress('user@example.com')).toBe(true)
    expect(isValidEmailAddress('user.name@example.com')).toBe(true)
    expect(isValidEmailAddress('user+tag@example.co.uk')).toBe(true)
  })

  it('rejects invalid email addresses', () => {
    expect(isValidEmailAddress('not-an-email')).toBe(false)
    expect(isValidEmailAddress('@example.com')).toBe(false)
    expect(isValidEmailAddress('user@')).toBe(false)
    expect(isValidEmailAddress('user@example')).toBe(false)
    expect(isValidEmailAddress('')).toBe(false)
  })

  it('trims whitespace before validation', () => {
    expect(isValidEmailAddress('  user@example.com  ')).toBe(true)
  })
})

describe('validateEmailMessage', () => {
  it('accepts valid email messages', () => {
    const result = validateEmailMessage(createMockEmail())
    expect(result.isValid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('rejects missing from field', () => {
    const result = validateEmailMessage({ body: 'test', timestamp: Date.now() } as Partial<EmailMessage>)
    expect(result.isValid).toBe(false)
    expect(result.error).toContain('from')
  })

  it('rejects invalid from address', () => {
    const result = validateEmailMessage(createMockEmail({ from: 'not-an-email' }))
    expect(result.isValid).toBe(false)
    expect(result.error).toContain('Invalid sender')
  })

  it('rejects missing body', () => {
    const result = validateEmailMessage(createMockEmail({ body: undefined as unknown as string }))
    expect(result.isValid).toBe(false)
    expect(result.error).toContain('body')
  })

  it('rejects missing timestamp', () => {
    const result = validateEmailMessage(createMockEmail({ timestamp: undefined as unknown as number }))
    expect(result.isValid).toBe(false)
    expect(result.error).toContain('timestamp')
  })
})
