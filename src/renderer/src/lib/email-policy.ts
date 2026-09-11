/**
 * email-policy.ts — Confidence gate and draft/policy layer for email responses.
 *
 * This module implements the safety layer that decides whether an AI-generated
 * email response should be:
 *   1. Sent directly (high confidence, safe topics)
 *   2. Created as a draft for human review (medium confidence, uncertain topics)
 *   3. Escalated to a human agent (low confidence, sensitive topics)
 *
 * Design principles:
 *   - Safe-by-default: when in doubt, create a draft
 *   - Topic-aware: certain topics (refunds, legal, security) always escalate
 *   - Confidence-scored: uses LLM self-assessment + heuristic signals
 *   - Auditable: every decision is logged with rationale
 */

import { type LLMMessage } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The action to take after generating an email response.
 */
export type EmailResponseAction = 'send' | 'draft' | 'escalate'

/**
 * Result of the confidence gate evaluation.
 */
export interface EmailPolicyDecision {
  /** The action to take */
  action: EmailResponseAction
  /** Confidence score from 0.0 to 1.0 */
  confidence: number
  /** Human-readable rationale for the decision */
  rationale: string
  /** Whether the response contains sensitive topic triggers */
  hasSensitiveTopic: boolean
  /** List of triggered sensitive topics (if any) */
  sensitiveTopics: string[]
}

/**
 * Metadata about a generated email response, used for policy evaluation.
 */
export interface EmailResponseContext {
  /** The generated response text */
  responseText: string
  /** The original user email content */
  originalContent: string
  /** Whether RAG/knowledge base was consulted */
  usedRag: boolean
  /** Whether the response contains uncertainty markers */
  hasUncertaintyMarkers: boolean
  /** Number of tool calls made during generation */
  toolCallCount: number
  /** Whether the response references specific facts from the knowledge base */
  citesKnowledgeBase: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Topics that always trigger escalation regardless of confidence.
 * These are high-risk areas where AI should not respond autonomously.
 */
const ESCALATION_TOPICS = [
  'refund',
  'chargeback',
  'dispute',
  'legal',
  'lawsuit',
  'attorney',
  'lawyer',
  'complaint',
  'regulator',
  'gdpr',
  'data breach',
  'security incident',
  'account compromise',
  'unauthorized',
  'fraud',
  'cancel subscription',
  'delete account',
  'do not contact',
  'unsubscribe',
]

/**
 * Phrases that indicate uncertainty or hallucination risk.
 * When detected, the response is downgraded to draft.
 */
const UNCERTAINTY_MARKERS = [
  'i think',
  'i believe',
  'probably',
  'might be',
  'could be',
  'not sure',
  'i don\'t have access',
  'i don\'t have that information',
  'i cannot confirm',
  'i cannot verify',
  'please verify',
  'to the best of my knowledge',
]

/**
 * Minimum confidence score to allow direct sending.
 * Responses below this threshold become drafts.
 */
const MIN_SEND_CONFIDENCE = 0.8

/**
 * Minimum confidence score before escalation.
 * Responses below this threshold are escalated to human agents.
 */
const MIN_DRAFT_CONFIDENCE = 0.5

// ── Policy Evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluates whether an AI-generated email response should be sent, drafted, or escalated.
 *
 * The evaluation uses a two-layer approach:
 *   1. Heuristic layer — fast pattern matching for sensitive topics and uncertainty
 *   2. Confidence layer — score-based assessment of response quality
 *
 * Decision flow:
 *   - If sensitive topic detected → ESCALATE (regardless of confidence)
 *   - If confidence < MIN_DRAFT_CONFIDENCE → ESCALATE
 *   - If confidence < MIN_SEND_CONFIDENCE → DRAFT
 *   - Otherwise → SEND
 *
 * @param context - The response context to evaluate
 * @returns A policy decision with action, confidence, and rationale
 *
 * @example
 * const decision = evaluateEmailPolicy({
 *   responseText: 'Your order will arrive tomorrow.',
 *   originalContent: 'When will my order arrive?',
 *   usedRag: true,
 *   hasUncertaintyMarkers: false,
 *   toolCallCount: 2,
 *   citesKnowledgeBase: true,
 * })
 * // → { action: 'send', confidence: 0.95, rationale: '...' }
 */
export function evaluateEmailPolicy(context: EmailResponseContext): EmailPolicyDecision {
  // Layer 1: Check the complete exchange for sensitive topics. A neutral answer
  // must not make a sensitive inbound request eligible for automatic sending.
  const sensitiveTopics = detectSensitiveTopics(
    `${context.originalContent}\n${context.responseText}`
  )
  const hasSensitiveTopic = sensitiveTopics.length > 0

  if (hasSensitiveTopic) {
    return {
      action: 'escalate',
      confidence: 0,
      rationale: `Email contains sensitive topic(s): ${sensitiveTopics.join(', ')}. Requires human review.`,
      hasSensitiveTopic: true,
      sensitiveTopics,
    }
  }

  // Layer 2: Calculate confidence score
  const confidence = calculateConfidence(context)

  // Layer 3: Apply decision thresholds
  if (confidence < MIN_DRAFT_CONFIDENCE) {
    return {
      action: 'escalate',
      confidence,
      rationale: `Low confidence score (${confidence.toFixed(2)}). Response may be inaccurate or incomplete.`,
      hasSensitiveTopic: false,
      sensitiveTopics: [],
    }
  }

  if (confidence < MIN_SEND_CONFIDENCE) {
    return {
      action: 'draft',
      confidence,
      rationale: `Moderate confidence (${confidence.toFixed(2)}). Recommended for human review before sending.`,
      hasSensitiveTopic: false,
      sensitiveTopics: [],
    }
  }

  return {
    action: 'send',
    confidence,
    rationale: `High confidence (${confidence.toFixed(2)}). Safe to send directly.`,
    hasSensitiveTopic: false,
    sensitiveTopics: [],
  }
}

/**
 * Detects sensitive topics in the response text.
 *
 * Uses case-insensitive substring matching against a curated list of
 * high-risk topics. This is intentionally conservative — false positives
 * (escalating safe responses) are preferred over false negatives
 * (sending risky responses).
 *
 * For multi-word topics, checks that all words appear in the text
 * (order-independent) to handle variations like "delete your account".
 *
 * @param text - The response text to scan
 * @returns Array of detected sensitive topic keywords
 */
function detectSensitiveTopics(text: string): string[] {
  const lowerText = text.toLowerCase()
  return ESCALATION_TOPICS.filter((topic) => {
    const words = topic.toLowerCase().split(/\s+/)
    return words.every((word) => lowerText.includes(word))
  })
}

/**
 * Calculates a confidence score for the response.
 *
 * Scoring factors (weighted):
 *   - RAG usage (+0.3) — grounded responses are more reliable
 *   - Knowledge base citations (+0.2) — specific facts increase confidence
 *   - No uncertainty markers (+0.2) — confident language
 *   - Tool call activity (+0.1 per call, max +0.2) — active information gathering
 *   - Base score (+0.1) — minimum baseline
 *
 * Maximum score: 1.0
 * Minimum score: 0.1
 *
 * @param context - The response context
 * @returns Confidence score from 0.0 to 1.0
 */
function calculateConfidence(context: EmailResponseContext): number {
  let score = 0.1 // Base score

  // RAG usage — most important signal
  if (context.usedRag) {
    score += 0.3
  }

  // Knowledge base citations
  if (context.citesKnowledgeBase) {
    score += 0.2
  }

  // No uncertainty markers
  if (!context.hasUncertaintyMarkers) {
    score += 0.2
  }

  // Tool call activity (capped at 2 calls for max bonus)
  const toolBonus = Math.min(context.toolCallCount * 0.1, 0.2)
  score += toolBonus

  // Penalty for uncertainty markers detected in response
  const uncertaintyCount = countUncertaintyMarkers(context.responseText)
  if (uncertaintyCount > 0) {
    score -= uncertaintyCount * 0.1
  }

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score))
}

/**
 * Counts the number of uncertainty markers in the response text.
 *
 * @param text - The response text to scan
 * @returns Number of uncertainty markers found
 */
function countUncertaintyMarkers(text: string): number {
  const lowerText = text.toLowerCase()
  return UNCERTAINTY_MARKERS.filter((marker) => lowerText.includes(marker)).length
}

// ── LLM Self-Assessment Prompt ────────────────────────────────────────────────

/**
 * Generates a system prompt for LLM self-assessment of response confidence.
 *
 * This prompt is prepended to the agent's system instructions when the
 * email channel is active. It instructs the agent to self-evaluate its
 * confidence before responding.
 *
 * @returns LLMMessage with the self-assessment instructions
 */
export function getConfidenceGatePrompt(): LLMMessage {
  return {
    role: 'system',
    content: `CONFIDENCE SELF-ASSESSMENT: Before generating your response, evaluate your confidence level:

HIGH CONFIDENCE (send directly):
- You found the answer in the knowledge base (rag_search returned results)
- The query is straightforward and within your expertise
- You can cite specific facts or policies

MEDIUM CONFIDENCE (draft for review):
- The answer is partially in the knowledge base but requires inference
- You're reasonably sure but not 100% confident
- The query is common but the answer may have edge cases

LOW CONFIDENCE (escalate to human):
- The knowledge base has no relevant information
- The query involves sensitive topics (refunds, legal, security)
- You would need to guess or make assumptions

RULES:
1. If you used rag_search and found relevant results → HIGH confidence
2. If rag_search returned no results → LOW confidence (escalate)
3. If the user mentions refunds, legal issues, or security → LOW confidence (escalate)
4. When in doubt, err on the side of caution → MEDIUM confidence (draft)`,
  }
}

// ── Draft Response Builder ────────────────────────────────────────────────────

/**
 * Wraps a generated response with draft metadata for the approval workflow.
 *
 * @param responseText - The AI-generated response text
 * @param policyDecision - The policy evaluation result
 * @param originalEmail - The original email that triggered this response
 * @returns Draft object ready for the approval UI
 */
export function createDraftResponse(
  responseText: string,
  policyDecision: EmailPolicyDecision,
  originalEmail: {
    from: string
    subject: string
    to?: string
    inReplyTo?: string
    references?: string
    accountName?: string
  }
): EmailDraft {
  return {
    id: `draft_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    responseText,
    originalFrom: originalEmail.from,
    originalSubject: originalEmail.subject,
    replyTo: originalEmail.to || originalEmail.from,
    inReplyTo: originalEmail.inReplyTo,
    references: originalEmail.references,
    accountName: originalEmail.accountName,
    policyDecision,
    createdAt: Date.now(),
    status: policyDecision.action === 'escalate' ? 'escalated' : 'pending_review',
  }
}

/**
 * A draft email response awaiting human review.
 */
export interface EmailDraft {
  /** Unique draft identifier */
  id: string
  /** The AI-generated response text */
  responseText: string
  /** Original sender email */
  originalFrom: string
  /** Original email subject */
  originalSubject: string
  /** Recipient for outbound reply */
  replyTo: string
  /** Optional threading header */
  inReplyTo?: string
  /** Optional thread references */
  references?: string
  /** Optional account label used by MCP server */
  accountName?: string
  /** Policy decision that created this draft */
  policyDecision: EmailPolicyDecision
  /** Timestamp when the draft was created */
  createdAt: number
  /** Current status of the draft */
  status: 'pending_review' | 'approved' | 'rejected' | 'escalated' | 'sent' | 'failed'
}
