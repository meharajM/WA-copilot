import type { AutonomyMode, ResponseDecision } from './AutonomousSupervisor'

export interface PolicyInput {
  mode: AutonomyMode
  responsePermission: boolean
  optedOut: boolean
  withinResponseWindow: boolean
  staleRevision: boolean
  decision: ResponseDecision
}

export type PolicyDisposition = 'send' | 'draft' | 'escalate'

export function isDispatchAllowed(mode: AutonomyMode, responsePermission: boolean, paused: boolean, conversationPaused: boolean): boolean {
  return mode === 'auto' && responsePermission && !paused && !conversationPaused
}

export function canEnableAutoMode(currentMode: AutonomyMode, nextMode: AutonomyMode): boolean {
  return nextMode !== 'auto' || currentMode === 'draft' || currentMode === 'auto'
}

export function shouldAutoResume(state: { status: string; paused: boolean; recoveryMode?: boolean }): boolean {
  return state.status === 'running' && !state.paused && state.recoveryMode !== true
}

export function evaluateAutonomyPolicy(input: PolicyInput): { disposition: PolicyDisposition; reason: string } {
  if (input.optedOut) return { disposition: 'escalate', reason: 'customer_opted_out' }
  if (input.staleRevision) return { disposition: 'escalate', reason: 'stale_conversation_revision' }
  if (input.decision.escalated || !input.decision.text) return { disposition: 'escalate', reason: input.decision.reason }
  if (input.decision.grounding !== 'grounded' || input.decision.confidence < 0.8) return { disposition: 'escalate', reason: 'decision_failed_policy_gate' }
  if (!input.withinResponseWindow) return { disposition: 'escalate', reason: 'response_window_expired' }
  if (input.mode === 'draft' || !input.responsePermission) return { disposition: 'draft', reason: 'approval_required' }
  if (input.mode !== 'auto') return { disposition: 'escalate', reason: 'autonomous_mode_not_enabled' }
  return { disposition: 'send', reason: 'policy_approved' }
}
