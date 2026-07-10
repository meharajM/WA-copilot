import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEmailStore } from '../../src/renderer/src/stores/emailStore'
import {
  generateEmailSessionKey,
  normalizeSubject,
  normalizeEmailAddress,
  convertEmailToLLMMessage,
  generateEmailSessionTitle,
  EMAIL_CHANNEL_PREFIX,
  type EmailMessage,
} from '../../src/renderer/src/lib/email-integration'
import { useChatStore } from '../../src/renderer/src/stores/chatStore'

// ── Test Helpers ──────────────────────────────────────────────────────────────

function resetEmailStore(): void {
  useEmailStore.setState({
    connectionState: {
      status: 'disconnected',
      error: null,
      lastSyncAt: null,
      unreadCount: 0,
    },
    config: {
      provider: 'imap-smtp',
      gmailAuthMode: 'app-password',
      imapHost: '',
      imapPort: 993,
      smtpHost: '',
      smtpPort: 587,
      emailAddress: '',
      accountName: 'default',
      userName: '',
      imapTls: true,
      smtpTls: true,
      pollingIntervalSeconds: 60,
      enabled: false,
      autoReplyMode: false,
      draftMode: true,
    },
  })
}

function resetChatStore(): void {
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    _processingSessions: new Map(),
  })
}

function createMockEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: `email_${Date.now()}`,
    from: 'customer@example.com',
    to: 'support@business.com',
    subject: 'Help with my order',
    body: 'Hi, I need help with order #12345.',
    bodyType: 'text',
    messageId: `<msg${Date.now()}@mail.example.com>`,
    timestamp: Date.now(),
    isFromMe: false,
    ...overrides,
  }
}

// ── Email Store Configuration ─────────────────────────────────────────────────

describe('email store configuration', () => {
  beforeEach(() => {
    resetEmailStore()
  })

  it('starts with email channel disabled and draft mode on', () => {
    const { config } = useEmailStore.getState()

    expect(config.enabled).toBe(false)
    expect(config.draftMode).toBe(true)
    expect(config.autoReplyMode).toBe(false)
    expect(config.pollingIntervalSeconds).toBe(60)
  })

  it('enables and disables the email channel', () => {
    const { setEnabled } = useEmailStore.getState()

    setEnabled(true)
    expect(useEmailStore.getState().config.enabled).toBe(true)

    setEnabled(false)
    expect(useEmailStore.getState().config.enabled).toBe(false)
  })

  it('toggles auto-reply mode', () => {
    const { setAutoReplyMode } = useEmailStore.getState()

    setAutoReplyMode(true)
    expect(useEmailStore.getState().config.autoReplyMode).toBe(true)

    setAutoReplyMode(false)
    expect(useEmailStore.getState().config.autoReplyMode).toBe(false)
  })

  it('toggles draft mode', () => {
    const { setDraftMode } = useEmailStore.getState()

    setDraftMode(false)
    expect(useEmailStore.getState().config.draftMode).toBe(false)

    setDraftMode(true)
    expect(useEmailStore.getState().config.draftMode).toBe(true)
  })

  it('updates connection settings', () => {
    const { setConnectionSettings } = useEmailStore.getState()

    setConnectionSettings({
      emailAddress: 'test@example.com',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
    })

    const config = useEmailStore.getState().config
    expect(config.emailAddress).toBe('test@example.com')
    expect(config.imapHost).toBe('imap.example.com')
    expect(config.smtpHost).toBe('smtp.example.com')
    // Unchanged fields should retain defaults
    expect(config.imapPort).toBe(993)
    expect(config.smtpPort).toBe(587)
  })

  it('enforces minimum polling interval of 30 seconds', () => {
    const { setPollingInterval } = useEmailStore.getState()

    setPollingInterval(10)
    expect(useEmailStore.getState().config.pollingIntervalSeconds).toBe(30)

    setPollingInterval(120)
    expect(useEmailStore.getState().config.pollingIntervalSeconds).toBe(120)
  })

  it('updates connection state', () => {
    const { setConnectionState } = useEmailStore.getState()

    setConnectionState({
      status: 'connected',
      error: null,
      lastSyncAt: Date.now(),
      unreadCount: 5,
    })

    const state = useEmailStore.getState().connectionState
    expect(state.status).toBe('connected')
    expect(state.unreadCount).toBe(5)
    expect(state.lastSyncAt).toBeDefined()
  })

  it('resets connection state', () => {
    const { setConnectionState, resetConnectionState } = useEmailStore.getState()

    setConnectionState({
      status: 'error',
      error: 'Connection failed',
      lastSyncAt: Date.now(),
      unreadCount: 0,
    })

    resetConnectionState()

    const state = useEmailStore.getState().connectionState
    expect(state.status).toBe('disconnected')
    expect(state.error).toBeNull()
    expect(state.lastSyncAt).toBeNull()
  })
})

// ── Email Session Mapping ─────────────────────────────────────────────────────

describe('email session mapping', () => {
  beforeEach(() => {
    resetChatStore()
  })

  it('creates a session with email channel metadata', () => {
    const email = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order inquiry',
    })

    const sessionKey = generateEmailSessionKey(email)
    const title = generateEmailSessionTitle(email)

    const { createSession } = useChatStore.getState()
    const sessionId = createSession()

    useChatStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, channel: 'email' as const, contact_id: sessionKey.sender, title }
          : s
      ),
    }))

    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)

    expect(session?.channel).toBe('email')
    expect(session?.contact_id).toBe('alice@example.com')
    expect(session?.title).toBe('Order inquiry')
  })

  it('finds existing session for reply thread', () => {
    const email1 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order inquiry',
      messageId: '<root001@mail.example.com>',
    })

    const email2 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Re: Order inquiry',
      inReplyTo: '<root001@mail.example.com>',
      references: '<root001@mail.example.com>',
      messageId: '<reply002@mail.example.com>',
    })

    const key1 = generateEmailSessionKey(email1)
    const key2 = generateEmailSessionKey(email2)

    // Both should map to the same thread root
    expect(key1.threadId).toBe(key2.threadId)
    expect(key1.sender).toBe(key2.sender)
  })

  it('converts email to LLM message with full context', () => {
    const email = createMockEmail({
      from: 'Bob <bob@example.com>',
      subject: 'Re: Fwd: Refund request',
      body: 'I would like a refund for order #999.',
    })

    const llmMsg = convertEmailToLLMMessage(email)

    expect(llmMsg.role).toBe('user')

    const content =
      typeof llmMsg.content === 'string'
        ? llmMsg.content
        : (llmMsg.content as Array<{ text: string }>).map((p) => p.text).join('')

    expect(content).toContain('From: Bob <bob@example.com>')
    expect(content).toContain('Subject: Refund request')
    expect(content).toContain('I would like a refund')
  })
})

// ── Email Channel Isolation ───────────────────────────────────────────────────

describe('email channel isolation', () => {
  beforeEach(() => {
    resetChatStore()
  })

  it('keeps email and whatsapp sessions separate', () => {
    const { createSession } = useChatStore.getState()

    const waId = createSession()
    const emailId = createSession()

    useChatStore.setState((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id === waId) return { ...s, channel: 'whatsapp' as const, contact_id: '14155551212', title: 'WA' }
        if (s.id === emailId) return { ...s, channel: 'email' as const, contact_id: 'user@example.com', title: 'Email' }
        return s
      }),
    }))

    const sessions = useChatStore.getState().sessions
    const waSession = sessions.find((s) => s.channel === 'whatsapp')
    const emailSession = sessions.find((s) => s.channel === 'email')

    expect(waSession).toBeDefined()
    expect(emailSession).toBeDefined()
    expect(waSession?.id).not.toBe(emailSession?.id)
  })

  it('filters sessions by email channel', () => {
    const { createSession } = useChatStore.getState()

    const channels: Array<'email' | 'whatsapp'> = ['email', 'whatsapp', 'email']
    for (let i = 0; i < 3; i++) {
      const id = createSession()
      const ch = channels[i]
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, channel: ch, contact_id: `user${i}@example.com`, title: `Session ${i}` } : s
        ),
      }))
    }

    const allSessions = useChatStore.getState().sessions
    const emailSessions = allSessions.filter((s) => s.channel === 'email')

    expect(emailSessions.length).toBe(2)
    expect(emailSessions.every((s) => s.channel === 'email')).toBe(true)
  })
})

// ── Email Threading Contract ──────────────────────────────────────────────────

describe('email threading contract', () => {
  it('maintains thread continuity across Re: prefixes', () => {
    const original = createMockEmail({
      from: 'alice@example.com',
      subject: 'Project update',
      messageId: '<proj001@mail.example.com>',
    })

    const reply1 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Re: Project update',
      inReplyTo: '<proj001@mail.example.com>',
      references: '<proj001@mail.example.com>',
      messageId: '<proj002@mail.example.com>',
    })

    const reply2 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Re: Re: Project update',
      inReplyTo: '<proj002@mail.example.com>',
      references: '<proj001@mail.example.com> <proj002@mail.example.com>',
      messageId: '<proj003@mail.example.com>',
    })

    const keyOriginal = generateEmailSessionKey(original)
    const keyReply1 = generateEmailSessionKey(reply1)
    const keyReply2 = generateEmailSessionKey(reply2)

    expect(keyReply1.threadId).toBe('proj001')
    expect(keyReply2.threadId).toBe('proj001')
    expect(keyOriginal.threadId).toBe('proj001')
  })

  it('handles missing Message-ID gracefully', () => {
    const email = createMockEmail({
      from: 'bob@example.com',
      subject: 'No headers email',
      messageId: undefined,
      inReplyTo: undefined,
      references: undefined,
    })

    const key = generateEmailSessionKey(email)

    expect(key.threadId).toMatch(/^subj_[a-z0-9]+$/)
    expect(key.sender).toBe('bob@example.com')
  })
})

// ── Subject Normalization ─────────────────────────────────────────────────────

describe('subject normalization', () => {
  it('strips common prefixes', () => {
    expect(normalizeSubject('Re: Hello')).toBe('Hello')
    expect(normalizeSubject('Fwd: Hello')).toBe('Hello')
    expect(normalizeSubject('FW: Hello')).toBe('Hello')
    expect(normalizeSubject('AW: Hallo')).toBe('Hallo')
    expect(normalizeSubject('SV: Hej')).toBe('Hej')
  })

  it('strips multiple nested prefixes', () => {
    expect(normalizeSubject('Re: Re: Fwd: Original')).toBe('Original')
  })

  it('returns unchanged subject with no prefix', () => {
    expect(normalizeSubject('Plain subject')).toBe('Plain subject')
  })
})

// ── Email Address Normalization ───────────────────────────────────────────────

describe('email address normalization', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmailAddress('  USER@EXAMPLE.COM  ')).toBe('user@example.com')
  })

  it('extracts from display name format', () => {
    expect(normalizeEmailAddress('John Doe <john@example.com>')).toBe('john@example.com')
  })

  it('returns empty for empty input', () => {
    expect(normalizeEmailAddress('')).toBe('')
  })
})
