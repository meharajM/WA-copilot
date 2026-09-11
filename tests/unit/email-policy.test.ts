import { describe, expect, it } from 'vitest'
import {
  evaluateEmailPolicy,
  getConfidenceGatePrompt,
  createDraftResponse,
  type EmailResponseContext,
  type EmailPolicyDecision,
} from '../../src/renderer/src/lib/email-policy'

// ── Test Helpers ──────────────────────────────────────────────────────────────

function createContext(overrides: Partial<EmailResponseContext> = {}): EmailResponseContext {
  return {
    responseText: 'Your order #12345 is currently being processed and will ship within 2 business days.',
    originalContent: 'When will my order ship?',
    usedRag: true,
    hasUncertaintyMarkers: false,
    toolCallCount: 2,
    citesKnowledgeBase: true,
    ...overrides,
  }
}

// ── Policy Evaluation: Send Decisions ─────────────────────────────────────────

describe('evaluateEmailPolicy — send decisions', () => {
  it('sends high-confidence responses with RAG and citations', () => {
    const decision = evaluateEmailPolicy(createContext())

    expect(decision.action).toBe('send')
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8)
    expect(decision.hasSensitiveTopic).toBe(false)
    expect(decision.sensitiveTopics).toHaveLength(0)
  })

  it('sends when RAG is used and no uncertainty markers', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 1,
      citesKnowledgeBase: true,
    }))

    expect(decision.action).toBe('send')
  })

  it('sends when confidence is above threshold', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 2,
      citesKnowledgeBase: true,
    }))

    expect(decision.confidence).toBeGreaterThanOrEqual(0.8)
    expect(decision.action).toBe('send')
  })
})

// ── Policy Evaluation: Draft Decisions ────────────────────────────────────────

describe('evaluateEmailPolicy — draft decisions', () => {
  it('drafts responses with moderate confidence', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 0,
      citesKnowledgeBase: false,
    }))

    expect(decision.action).toBe('draft')
    expect(decision.confidence).toBeLessThan(0.8)
    expect(decision.confidence).toBeGreaterThanOrEqual(0.5)
  })

  it('drafts responses with uncertainty markers', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I think your order will ship tomorrow based on our policy.',
      usedRag: true,
      hasUncertaintyMarkers: true,
      toolCallCount: 0,
      citesKnowledgeBase: true,
    }))

    // RAG (0.3) + citations (0.2) + base (0.1) - uncertainty penalty (0.1) = 0.5
    expect(decision.action).toBe('draft')
    expect(decision.confidence).toBeGreaterThanOrEqual(0.5)
    expect(decision.confidence).toBeLessThan(0.8)
  })

  it('drafts when no RAG but some signals present', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: false,
      hasUncertaintyMarkers: false,
      toolCallCount: 2,
      citesKnowledgeBase: false,
    }))

    expect(decision.action).toBe('draft')
  })
})

// ── Policy Evaluation: Escalation Decisions ───────────────────────────────────

describe('evaluateEmailPolicy — escalation decisions', () => {
  it('escalates responses about refunds', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I can process a refund for your order.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.hasSensitiveTopic).toBe(true)
    expect(decision.sensitiveTopics).toContain('refund')
    expect(decision.confidence).toBe(0)
  })

  it('escalates responses about legal matters', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'You should consult an attorney about this issue.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics.length).toBeGreaterThan(0)
  })

  it('escalates responses about security incidents', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'We detected a data breach affecting your account.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('data breach')
  })

  it('escalates responses about fraud', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'This appears to be unauthorized fraud on your account.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('fraud')
    expect(decision.sensitiveTopics).toContain('unauthorized')
  })

  it('escalates responses about GDPR', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'Under GDPR regulations, you have the right to...',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('gdpr')
  })

  it('escalates responses about account deletion', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'To delete your account, please...',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('delete account')
  })

  it('escalates low-confidence responses without sensitive topics', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: false,
      hasUncertaintyMarkers: true,
      toolCallCount: 0,
      citesKnowledgeBase: false,
      responseText: 'I think maybe something could probably happen, but I don\'t have access to that information.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.hasSensitiveTopic).toBe(false)
    expect(decision.confidence).toBeLessThan(0.5)
  })

  it('escalates even with high confidence if sensitive topic present', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I can confirm your refund has been processed.',
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 3,
      citesKnowledgeBase: true,
    }))

    // Sensitive topic overrides confidence
    expect(decision.action).toBe('escalate')
    expect(decision.hasSensitiveTopic).toBe(true)
  })
})

// ── Confidence Scoring ────────────────────────────────────────────────────────

describe('confidence scoring', () => {
  it('gives highest score with all positive signals', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 2,
      citesKnowledgeBase: true,
    }))

    expect(decision.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('gives lowest score with all negative signals', () => {
    const decision = evaluateEmailPolicy(createContext({
      usedRag: false,
      hasUncertaintyMarkers: true,
      toolCallCount: 0,
      citesKnowledgeBase: false,
      responseText: 'I\'m not sure and I don\'t have that information.',
    }))

    expect(decision.confidence).toBeLessThan(0.5)
  })

  it('caps tool call bonus at 2 calls', () => {
    const decision2 = evaluateEmailPolicy(createContext({
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 2,
      citesKnowledgeBase: true,
    }))

    const decision5 = evaluateEmailPolicy(createContext({
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 5,
      citesKnowledgeBase: true,
    }))

    // Both should be at or near max (tool bonus capped at 0.2)
    expect(decision5.confidence).toBeLessThanOrEqual(1.0)
    expect(decision5.confidence).toBeGreaterThanOrEqual(decision2.confidence)
  })

  it('penalizes multiple uncertainty markers', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I think it might be that I\'m not sure, and I cannot confirm this.',
      usedRag: true,
      hasUncertaintyMarkers: true,
      toolCallCount: 0,
      citesKnowledgeBase: false,
    }))

    expect(decision.confidence).toBeLessThan(0.5)
  })

  it('clamps confidence to [0, 1] range', () => {
    // Even with extreme negative signals, confidence should not go below 0
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I think probably maybe could be not sure don\'t have access cannot confirm cannot verify to the best of my knowledge I don\'t have that information.',
      usedRag: false,
      hasUncertaintyMarkers: true,
      toolCallCount: 0,
      citesKnowledgeBase: false,
    }))

    expect(decision.confidence).toBeGreaterThanOrEqual(0)
    expect(decision.confidence).toBeLessThanOrEqual(1)
  })
})

// ── Sensitive Topic Detection ─────────────────────────────────────────────────

describe('sensitive topic detection', () => {
  it('escalates when only the original inbound email contains a sensitive topic', () => {
    const decision = evaluateEmailPolicy({
      responseText: 'Thanks for contacting us. A team member will review your request.',
      originalContent: 'I need a refund for order 123.',
      usedRag: true,
      hasUncertaintyMarkers: false,
      toolCallCount: 2,
      citesKnowledgeBase: true,
    })

    expect(decision.action).toBe('escalate')
    expect(decision.hasSensitiveTopic).toBe(true)
    expect(decision.sensitiveTopics).toContain('refund')
  })

  it('detects chargeback mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I can help you file a chargeback.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('chargeback')
  })

  it('detects complaint mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I understand you want to file a complaint.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('complaint')
  })

  it('detects regulator mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'You can contact the regulator about this.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('regulator')
  })

  it('detects unsubscribe mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'To unsubscribe from our mailing list...',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('unsubscribe')
  })

  it('detects dispute mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I can help you resolve this dispute.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('dispute')
  })

  it('detects cancel subscription mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'To cancel your subscription, please...',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('cancel subscription')
  })

  it('detects do not contact mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'I will add you to the do not contact list.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('do not contact')
  })

  it('detects account compromise mentions', () => {
    const decision = evaluateEmailPolicy(createContext({
      responseText: 'Your account may have been compromised.',
    }))

    expect(decision.action).toBe('escalate')
    expect(decision.sensitiveTopics).toContain('account compromise')
  })
})

// ── Confidence Gate Prompt ────────────────────────────────────────────────────

describe('getConfidenceGatePrompt', () => {
  it('returns a system message', () => {
    const prompt = getConfidenceGatePrompt()

    expect(prompt.role).toBe('system')
  })

  it('includes confidence level definitions', () => {
    const prompt = getConfidenceGatePrompt()

    expect(prompt.content).toContain('HIGH CONFIDENCE')
    expect(prompt.content).toContain('MEDIUM CONFIDENCE')
    expect(prompt.content).toContain('LOW CONFIDENCE')
  })

  it('includes RAG-based rules', () => {
    const prompt = getConfidenceGatePrompt()

    expect(prompt.content).toContain('rag_search')
    expect(prompt.content).toContain('HIGH confidence')
    expect(prompt.content).toContain('LOW confidence')
  })

  it('includes sensitive topic escalation rules', () => {
    const prompt = getConfidenceGatePrompt()

    expect(prompt.content).toContain('refunds')
    expect(prompt.content).toContain('legal')
    expect(prompt.content).toContain('security')
  })
})

// ── Draft Response Builder ────────────────────────────────────────────────────

describe('createDraftResponse', () => {
  it('creates a draft with pending_review status for draft actions', () => {
    const policyDecision: EmailPolicyDecision = {
      action: 'draft',
      confidence: 0.65,
      rationale: 'Moderate confidence',
      hasSensitiveTopic: false,
      sensitiveTopics: [],
    }

    const draft = createDraftResponse(
      'Your order will ship tomorrow.',
      policyDecision,
      { from: 'customer@example.com', subject: 'Order status' }
    )

    expect(draft.id).toMatch(/^draft_/)
    expect(draft.responseText).toBe('Your order will ship tomorrow.')
    expect(draft.originalFrom).toBe('customer@example.com')
    expect(draft.originalSubject).toBe('Order status')
    expect(draft.status).toBe('pending_review')
    expect(draft.policyDecision).toBe(policyDecision)
    expect(draft.createdAt).toBeDefined()
  })

  it('creates a draft with escalated status for escalation actions', () => {
    const policyDecision: EmailPolicyDecision = {
      action: 'escalate',
      confidence: 0,
      rationale: 'Sensitive topic detected',
      hasSensitiveTopic: true,
      sensitiveTopics: ['refund'],
    }

    const draft = createDraftResponse(
      'I can process your refund.',
      policyDecision,
      { from: 'customer@example.com', subject: 'Refund request' }
    )

    expect(draft.status).toBe('escalated')
    expect(draft.policyDecision.action).toBe('escalate')
  })

  it('generates unique IDs for each draft', () => {
    const policyDecision: EmailPolicyDecision = {
      action: 'draft',
      confidence: 0.7,
      rationale: 'Test',
      hasSensitiveTopic: false,
      sensitiveTopics: [],
    }

    const draft1 = createDraftResponse('Response 1', policyDecision, { from: 'a@b.com', subject: 'Test' })
    const draft2 = createDraftResponse('Response 2', policyDecision, { from: 'a@b.com', subject: 'Test' })

    expect(draft1.id).not.toBe(draft2.id)
  })
})
