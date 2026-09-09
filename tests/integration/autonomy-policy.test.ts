import { describe, expect, it } from 'vitest'
import { canEnableAutoMode, evaluateAutonomyPolicy, isDispatchAllowed, shouldAutoResume } from '../../src/main/services/AutonomyPolicy'

const decision = { text: 'Answer', confidence: 0.9, grounding: 'grounded' as const, escalated: false, sensitiveTopic: false, reason: 'grounded' }

describe('autonomy policy', () => {
  it('requires explicit permission for sending', () => {
    expect(evaluateAutonomyPolicy({ mode: 'draft', responsePermission: false, optedOut: false, withinResponseWindow: true, staleRevision: false, decision }))
      .toEqual({ disposition: 'draft', reason: 'approval_required' })
  })

  it('escalates stale or expired work before send', () => {
    expect(evaluateAutonomyPolicy({ mode: 'auto', responsePermission: true, optedOut: false, withinResponseWindow: false, staleRevision: false, decision }).disposition).toBe('escalate')
    expect(evaluateAutonomyPolicy({ mode: 'auto', responsePermission: true, optedOut: false, withinResponseWindow: true, staleRevision: true, decision }).reason).toBe('stale_conversation_revision')
  })

  it('keeps observe-only and ungrounded decisions from sending', () => {
    expect(evaluateAutonomyPolicy({ mode: 'observe', responsePermission: true, optedOut: false, withinResponseWindow: true, staleRevision: false, decision }).disposition).toBe('escalate')
    expect(evaluateAutonomyPolicy({ mode: 'auto', responsePermission: true, optedOut: false, withinResponseWindow: true, staleRevision: false, decision: { ...decision, grounding: 'not_grounded' } }).reason).toBe('decision_failed_policy_gate')
  })

  it('always escalates opt-out, sensitive, or model-escalated decisions', () => {
    expect(evaluateAutonomyPolicy({ mode: 'auto', responsePermission: true, optedOut: true, withinResponseWindow: true, staleRevision: false, decision }).reason).toBe('customer_opted_out')
    expect(evaluateAutonomyPolicy({ mode: 'auto', responsePermission: true, optedOut: false, withinResponseWindow: true, staleRevision: false, decision: { ...decision, escalated: true, reason: 'sensitive_topic_requires_human' } }).reason).toBe('sensitive_topic_requires_human')
  })

  it('sends only in auto mode with permission and grounding', () => {
    expect(evaluateAutonomyPolicy({ mode: 'auto', responsePermission: true, optedOut: false, withinResponseWindow: true, staleRevision: false, decision })).toEqual({ disposition: 'send', reason: 'policy_approved' })
  })

  it('fails closed when permission is revoked during generation', () => {
    expect(isDispatchAllowed('auto', true, false, false)).toBe(true)
    expect(isDispatchAllowed('auto', false, false, false)).toBe(false)
    expect(isDispatchAllowed('auto', true, true, false)).toBe(false)
  })

  it('requires explicit draft mode before auto mode', () => {
    expect(canEnableAutoMode('observe', 'auto')).toBe(false)
    expect(canEnableAutoMode('observe', 'draft')).toBe(true)
    expect(canEnableAutoMode('draft', 'auto')).toBe(true)
  })

  it('only auto-resumes an interrupted running supervisor', () => {
    expect(shouldAutoResume({ status: 'running', paused: false })).toBe(true)
    expect(shouldAutoResume({ status: 'stopped', paused: true })).toBe(false)
    expect(shouldAutoResume({ status: 'running', paused: false, recoveryMode: true })).toBe(false)
  })
})
