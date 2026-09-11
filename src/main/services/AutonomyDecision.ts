export type DecisionGrounding = 'grounded' | 'not_grounded' | 'unavailable'

export interface ParsedAutonomyDecision {
  text: string | null
  confidence: number
  grounding: DecisionGrounding
}

export function draftContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function isStaleRevision(expected: number, current: number): boolean {
  return expected !== current
}

export function isOptOutMessage(content: string): boolean {
  const value = content.trim()
  return /^(please\s+)?stop[.!]?$|^(please\s+)?(?:unsubscribe|opt[- ]?out|remove me|do not message)\b/i.test(value)
}

export function isOptInMessage(content: string): boolean {
  return /^(please\s+)?(?:start|unstop|subscribe)[.!]?$|^(yes|y)[.!]?$/i.test(content.trim())
}

export function isAllowlistedSupportIntent(content: string): boolean {
  return /\b(?:hours?|open|closed|location|address|office|directions|shipping|delivery|track(?:ing)?|order status|availability|price|cost|features?|how does|return policy|business)\b/i.test(content)
}

export function isSensitiveSupportTopic(content: string): boolean {
  return /(payment|refund|chargeback|legal|lawsuit|medical|injury|password|otp|verification code|complaint)/i.test(content)
}

export function isPromptInjection(content: string): boolean {
  return /(ignore (?:all |any )?(?:previous|prior|system)|reveal (?:the )?(?:system|hidden) prompt|follow these instructions instead|developer message|disable (?:your )?safety|run this tool|execute (?:a )?command)/i.test(content)
}

export function isAccountSpecificRequest(content: string): boolean {
  return /\b(?:my|our)\s+(?:order|account|booking|shipment|delivery|subscription|invoice)\b|\b(order|ticket|case)[\s#:.-]*\d{3,}\b/i.test(content)
}

export function isWithinWhatsAppServiceWindow(receivedAt: number, now = Date.now()): boolean {
  return now >= receivedAt && now - receivedAt <= 24 * 60 * 60 * 1000
}

export function isWithinMetaMessagingWindow(receivedAt: number, now = Date.now()): boolean {
  return now >= receivedAt && now - receivedAt <= 24 * 60 * 60 * 1000
}

export function isAmbiguousSendError(error: string): boolean {
  return /timeout|timed out|socket hang up|econnreset|connection reset|delivery unknown/i.test(error)
}

export function isConfirmedPreSendTransientError(error: string): boolean {
  return /429|rate.?limit|too many requests/i.test(error)
}

export type ProviderErrorClass = 'auth' | 'permission' | 'rate_limit' | 'transient' | 'permanent'

export function classifyProviderError(error: string): ProviderErrorClass {
  if (/token|oauth|unauthori[sz]ed|access denied|authentication/i.test(error)) return 'auth'
  if (/permission|forbidden|not allowed/i.test(error)) return 'permission'
  if (/429|rate.?limit|too many requests/i.test(error)) return 'rate_limit'
  if (isAmbiguousSendError(error) || /5\d\d|network|temporar|unavailable/i.test(error)) return 'transient'
  return 'permanent'
}

/** Parse only the model fields the host is willing to trust. */
export function parseAutonomyDecision(raw: string): ParsedAutonomyDecision | null {
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const value = JSON.parse(candidate) as Record<string, unknown>
    const text = typeof value.text === 'string' ? value.text.trim() : ''
    const confidence = typeof value.confidence === 'number' ? value.confidence : NaN
    const grounding = value.grounding
    if (!text || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
    if (grounding !== 'grounded' && grounding !== 'not_grounded' && grounding !== 'unavailable') return null
    return { text, confidence, grounding }
  } catch {
    return null
  }
}
import { createHash } from 'node:crypto'
