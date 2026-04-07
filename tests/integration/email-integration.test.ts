import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../../src/renderer/src/stores/chatStore'
import {
  generateEmailSessionKey,
  normalizeSubject,
  normalizeEmailAddress,
  convertEmailToLLMMessage,
  getEmailSystemPrompt,
  generateEmailSessionTitle,
  EMAIL_CHANNEL_PREFIX,
  type EmailMessage,
} from '../../src/renderer/src/lib/email-integration'

// ── Test Helpers ──────────────────────────────────────────────────────────────

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

// ── Email Session Lifecycle ───────────────────────────────────────────────────

describe('email session lifecycle', () => {
  beforeEach(() => {
    resetChatStore()
  })

  it('creates a new email session with correct channel metadata', () => {
    const email = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order inquiry',
    })

    const sessionKey = generateEmailSessionKey(email)
    const title = generateEmailSessionTitle(email)

    // Simulate session creation (as would happen in useAgent)
    const { createSession } = useChatStore.getState()
    const sessionId = createSession()

    // Set email channel metadata
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? {
              ...s,
              channel: 'email' as const,
              contact_id: sessionKey.sender,
              title,
            }
          : s
      ),
    }))

    const session = useChatStore.getState().sessions.find(s => s.id === sessionId)

    expect(session).toBeDefined()
    expect(session?.channel).toBe('email')
    expect(session?.contact_id).toBe('alice@example.com')
    expect(session?.title).toBe('Order inquiry')
  })

  it('finds existing session by email thread key', () => {
    const email1 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order inquiry',
      messageId: '<root001@mail.example.com>',
    })

    const sessionKey1 = generateEmailSessionKey(email1)
    const title = generateEmailSessionTitle(email1)

    // Create first session
    const { createSession } = useChatStore.getState()
    const sessionId = createSession()
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, channel: 'email' as const, contact_id: sessionKey1.sender, title }
          : s
      ),
    }))

    // Simulate a reply to the same thread
    const email2 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Re: Order inquiry',
      inReplyTo: '<root001@mail.example.com>',
      messageId: '<reply002@mail.example.com>',
    })

    const sessionKey2 = generateEmailSessionKey(email2)

    // Thread ID should match (In-Reply-To points to same root)
    expect(sessionKey1.threadId).toBe(sessionKey2.threadId)
    expect(sessionKey1.sender).toBe(sessionKey2.sender)
  })

  it('creates separate sessions for different subjects from same sender', () => {
    const email1 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Order inquiry',
      messageId: '<order001@mail.example.com>',
    })

    const email2 = createMockEmail({
      from: 'alice@example.com',
      subject: 'Billing question',
      messageId: '<billing001@mail.example.com>',
    })

    const key1 = generateEmailSessionKey(email1)
    const key2 = generateEmailSessionKey(email2)

    // Same sender, different threads
    expect(key1.sender).toBe(key2.sender)
    expect(key1.threadId).not.toBe(key2.threadId)
    expect(key1.key).not.toBe(key2.key)
  })

  it('maps email message to chat session correctly', () => {
    const email = createMockEmail({
      from: 'bob@example.com',
      subject: 'Refund request',
      body: 'I would like a refund for order #999.',
    })

    const llmMsg = convertEmailToLLMMessage(email)
    const title = generateEmailSessionTitle(email)

    // Create session and add message
    const { createSession, addSessionMessage } = useChatStore.getState()
    const sessionId = createSession()

    useChatStore.setState(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, channel: 'email' as const, contact_id: normalizeEmailAddress(email.from), title }
          : s
      ),
    }))

    const storeMsg = addSessionMessage(sessionId, {
      role: 'user',
      content: typeof llmMsg.content === 'string' ? llmMsg.content : (llmMsg.content as Array<{ text: string }>).map(p => p.text).join('\n'),
      attachments: llmMsg.attachments,
    })

    const session = useChatStore.getState().sessions.find(s => s.id === sessionId)

    expect(session?.messages.length).toBe(1)
    expect(session?.messages[0].role).toBe('user')
    expect(session?.messages[0].content).toContain('From: bob@example.com')
    expect(session?.messages[0].content).toContain('Refund request')
    expect(session?.messages[0].content).toContain('I would like a refund')
  })
})

// ── Email System Prompt Integration ───────────────────────────────────────────

describe('email system prompt integration', () => {
  it('provides thread-aware instructions', () => {
    const prompt = getEmailSystemPrompt({ name: 'TestCo', tone: 'friendly' })

    expect(prompt.role).toBe('system')
    expect(prompt.content).toContain('THREAD AWARENESS')
    expect(prompt.content).toContain('TestCo')
    expect(prompt.content).toContain('friendly')
  })

  it('includes grounding and escalation rules', () => {
    const prompt = getEmailSystemPrompt()

    expect(prompt.content).toContain('rag_search')
    expect(prompt.content).toContain('NO HALLUCINATIONS')
    expect(prompt.content).toContain('ESCALATION')
    expect(prompt.content).toContain('draft for approval')
  })
})

// ── Channel Isolation ─────────────────────────────────────────────────────────

describe('channel isolation', () => {
  beforeEach(() => {
    resetChatStore()
  })

  it('keeps email and whatsapp sessions separate', () => {
    const { createSession } = useChatStore.getState()

    // Create WhatsApp session
    const waSessionId = createSession()
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s =>
        s.id === waSessionId
          ? { ...s, channel: 'whatsapp' as const, contact_id: '14155551212@s.whatsapp.net', title: 'WhatsApp Customer' }
          : s
      ),
    }))

    // Create Email session
    const emailSessionId = createSession()
    useChatStore.setState(state => ({
      sessions: state.sessions.map(s =>
        s.id === emailSessionId
          ? { ...s, channel: 'email' as const, contact_id: 'customer@example.com', title: 'Email Customer' }
          : s
      ),
    }))

    const sessions = useChatStore.getState().sessions

    const waSession = sessions.find(s => s.channel === 'whatsapp')
    const emailSession = sessions.find(s => s.channel === 'email')

    expect(waSession).toBeDefined()
    expect(emailSession).toBeDefined()
    expect(waSession?.id).not.toBe(emailSession?.id)
    expect(waSession?.contact_id).not.toBe(emailSession?.contact_id)
  })

  it('filters sessions by channel', () => {
    const { createSession } = useChatStore.getState()

    // Create mixed sessions
    const sessions = [
      { channel: 'whatsapp' as const, contact_id: '1111@s.whatsapp.net', title: 'WA 1' },
      { channel: 'email' as const, contact_id: 'a@example.com', title: 'Email 1' },
      { channel: 'whatsapp' as const, contact_id: '2222@s.whatsapp.net', title: 'WA 2' },
      { channel: 'email' as const, contact_id: 'b@example.com', title: 'Email 2' },
    ]

    for (const s of sessions) {
      const id = createSession()
      useChatStore.setState(state => ({
        sessions: state.sessions.map(sess =>
          sess.id === id ? { ...sess, ...s } : sess
        ),
      }))
    }

    const allSessions = useChatStore.getState().sessions
    const emailSessions = allSessions.filter(s => s.channel === 'email')
    const whatsappSessions = allSessions.filter(s => s.channel === 'whatsapp')

    expect(emailSessions.length).toBe(2)
    expect(whatsappSessions.length).toBe(2)
    expect(emailSessions.every(s => s.channel === 'email')).toBe(true)
    expect(whatsappSessions.every(s => s.channel === 'whatsapp')).toBe(true)
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

    // All replies should map to the same thread root
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

    // Should fall back to subject hash
    expect(key.threadId).toMatch(/^subj_[a-z0-9]+$/)
    expect(key.sender).toBe('bob@example.com')
  })
})
