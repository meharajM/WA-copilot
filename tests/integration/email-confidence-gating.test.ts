import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../src/renderer/src/stores/chatStore'
import { useEmailStore } from '../../src/renderer/src/stores/emailStore'
import {
  evaluateEmailPolicy,
  type EmailResponseContext,
  type EmailPolicyDecision,
} from '../../src/renderer/src/lib/email-policy'

// Mock the agent runtime and tool calls
const mockAgentResponse = async (context: EmailResponseContext): Promise<EmailPolicyDecision> => {
  return evaluateEmailPolicy(context)
}

function resetStores(): void {
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    _processingSessions: new Map(),
  })
  
  useEmailStore.setState({
    connectionState: {
      status: 'disconnected',
      error: null,
      lastSyncAt: null,
      unreadCount: 0,
    },
    config: {
      accountName: 'default',
      provider: 'imap-smtp',
      gmailAuthMode: 'app-password',
      imapHost: '',
      imapPort: 993,
      smtpHost: '',
      smtpPort: 587,
      emailAddress: '',
      userName: '',
      imapTls: true,
      smtpTls: true,
      pollingIntervalSeconds: 60,
      enabled: false,
      autoReplyMode: false,
      draftMode: true,
    }
  })
}

describe('email confidence gating integration', () => {
  beforeEach(() => {
    resetStores()
  })

  it('sends high-confidence responses with RAG and citations', async () => {
    const context: EmailResponseContext = {
      responseText: 'Your order #12345 is currently being processed and will ship within 2 business days.',
      originalContent: 'When will my order ship?',
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 2,
      citesKnowledgeBase: true,
    }

    const decision = await mockAgentResponse(context)
    
    expect(decision.action).toBe('send')
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8)
    expect(decision.hasSensitiveTopic).toBe(false)
  })

  it('creates draft for medium-confidence responses', async () => {
    const context: EmailResponseContext = {
      responseText: 'I believe your order should arrive soon based on our shipping policy.',
      originalContent: 'When will my order arrive?',
      usedRag: true,
      hasUncertaintyMarkers: true, // Contains "I believe"
      toolCallCount: 1,
      citesKnowledgeBase: true,
    }

    const decision = await mockAgentResponse(context)
    
    expect(decision.action).toBe('draft')
    expect(decision.confidence).toBeLessThan(0.8)
    expect(decision.confidence).toBeGreaterThanOrEqual(0.5)
  })

  it('escalates low-confidence responses', async () => {
    const context: EmailResponseContext = {
      responseText: 'I think maybe something could happen, but I dont have access to that information.',
      originalContent: 'Can you tell me about our internal processes?',
      usedRag: false,
      hasUncertaintyMarkers: true,
      toolCallCount: 0,
      citesKnowledgeBase: false,
    }

    const decision = await mockAgentResponse(context)
    
    expect(decision.action).toBe('escalate')
    expect(decision.confidence).toBeLessThan(0.5)
  })

  it('escalates responses with sensitive topics regardless of confidence', async () => {
    const context: EmailResponseContext = {
      responseText: 'I can process a refund for your order #12345.',
      originalContent: 'I want a refund for my recent purchase.',
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 3,
      citesKnowledgeBase: true,
    }

    const decision = await mockAgentResponse(context)
    
    expect(decision.action).toBe('escalate')
    expect(decision.hasSensitiveTopic).toBe(true)
    expect(decision.sensitiveTopics).toContain('refund')
  })

  it('handles uncertain language in responses appropriately', async () => {
    const context: EmailResponseContext = {
      responseText: 'The order might be delayed due to weather conditions.',
      originalContent: 'Is there a delay with my order shipment?',
      usedRag: true,
      hasUncertaintyMarkers: true,
      toolCallCount: 1,
      citesKnowledgeBase: true,
    }

    const decision = await mockAgentResponse(context)
    
    // Should be draft due to uncertainty markers
    expect(decision.action).toBe('draft')
    expect(decision.confidence).toBeLessThan(0.8)
    expect(decision.confidence).toBeGreaterThanOrEqual(0.5)
  })
})
