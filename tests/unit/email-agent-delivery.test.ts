import { describe, expect, it, vi } from 'vitest'
import {
  LOW_CONFIDENCE_EMAIL_ACKNOWLEDGEMENT,
  handleEmailPostResponse,
  hasHandledEmailSendToolCall,
} from '../../src/renderer/src/hooks/useAgent'
import type { EmailMessage } from '../../src/renderer/src/lib/email-integration'
import type { EmailPolicyDecision } from '../../src/renderer/src/lib/email-policy'

const inboundEmail: EmailMessage = {
  id: 'email-1',
  from: 'customer@example.com',
  to: 'support@example.com',
  subject: 'Question about an unusual order',
  body: 'Can someone review this unusual request?',
  bodyType: 'text',
  timestamp: 1,
  messageId: '<message-1@example.com>',
  references: '<root@example.com>',
  isFromMe: false,
}

const lowConfidenceDecision: EmailPolicyDecision = {
  action: 'escalate',
  confidence: 0.3,
  rationale: 'Low confidence score (0.30). Response may be inaccurate or incomplete.',
  hasSensitiveTopic: false,
  sensitiveTopics: [],
}

describe('email agent delivery ownership', () => {
  it('yields post-response delivery after a successful email send tool result', () => {
    expect(hasHandledEmailSendToolCall([
      {
        id: 'call-1',
        name: 'email_send_message',
        arguments: {},
        result: 'Email sent successfully.',
      },
    ])).toBe(true)
  })

  it('yields post-response delivery after draft mode handles the send tool', () => {
    expect(hasHandledEmailSendToolCall([
      {
        id: 'call-1',
        function: { name: 'email_send_message' },
        result: JSON.stringify({ status: 'draft_created', draftId: 'draft-1' }),
      },
    ])).toBe(true)
  })

  it('retains post-response fallback when the email send tool fails', () => {
    expect(hasHandledEmailSendToolCall([
      {
        id: 'call-1',
        name: 'email_send_message',
        arguments: {},
        result: JSON.stringify({ error: 'SMTP connection failed' }),
      },
    ])).toBe(false)
  })

  it('retains post-response fallback while the email send tool is pending', () => {
    expect(hasHandledEmailSendToolCall([
      { id: 'call-1', name: 'email_send_message', arguments: {} },
    ])).toBe(false)
  })

  it('does not suppress post-response delivery for unrelated tools', () => {
    expect(hasHandledEmailSendToolCall([
      { id: 'call-1', name: 'rag_search', arguments: {}, result: 'success' },
    ])).toBe(false)
  })

  it('sends one neutral threaded acknowledgement and creates one owner review draft', async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    const addDraft = vi.fn()

    const outcome = await handleEmailPostResponse(
      {
        responseText: 'A proposed owner response.',
        inboundEmailMessage: inboundEmail,
        decision: lowConfidenceDecision,
        draftMode: false,
        accountName: 'support',
        emailSendHandledByAgent: false,
      },
      { send, addDraft }
    )

    expect(outcome).toBe('acknowledged')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      to: 'customer@example.com',
      subject: 'Re: Question about an unusual order',
      body: LOW_CONFIDENCE_EMAIL_ACKNOWLEDGEMENT,
      inReplyTo: '<message-1@example.com>',
      references: '<root@example.com>',
      accountName: 'support',
    })
    expect(addDraft).toHaveBeenCalledTimes(1)
    expect(addDraft.mock.calls[0][0]).toMatchObject({
      responseText: 'A proposed owner response.',
      replyTo: 'customer@example.com',
      inReplyTo: '<message-1@example.com>',
      references: '<root@example.com>',
      accountName: 'support',
      status: 'escalated',
    })
  })

  it('does not acknowledge sensitive or do-not-contact email', async () => {
    const send = vi.fn()
    const addDraft = vi.fn()
    const sensitiveDecision: EmailPolicyDecision = {
      ...lowConfidenceDecision,
      hasSensitiveTopic: true,
      sensitiveTopics: ['do not contact'],
    }

    const outcome = await handleEmailPostResponse(
      {
        responseText: 'Proposed internal response.',
        inboundEmailMessage: inboundEmail,
        decision: sensitiveDecision,
        draftMode: false,
        emailSendHandledByAgent: false,
      },
      { send, addDraft }
    )

    expect(outcome).toBe('drafted')
    expect(send).not.toHaveBeenCalled()
    expect(addDraft).toHaveBeenCalledTimes(1)
    expect(addDraft.mock.calls[0][0].status).toBe('escalated')
  })

  it('does not send or create a duplicate review item after a handled email tool result', async () => {
    const send = vi.fn()
    const addDraft = vi.fn()

    const outcome = await handleEmailPostResponse(
      {
        responseText: 'A proposed owner response.',
        inboundEmailMessage: inboundEmail,
        decision: lowConfidenceDecision,
        draftMode: false,
        emailSendHandledByAgent: true,
      },
      { send, addDraft }
    )

    expect(outcome).toBe('skipped')
    expect(send).not.toHaveBeenCalled()
    expect(addDraft).not.toHaveBeenCalled()
  })

  it('keeps one owner review draft when the acknowledgement send fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('SMTP unavailable'))
    const addDraft = vi.fn()

    const outcome = await handleEmailPostResponse(
      {
        responseText: 'A proposed owner response.',
        inboundEmailMessage: inboundEmail,
        decision: lowConfidenceDecision,
        draftMode: false,
        emailSendHandledByAgent: false,
      },
      { send, addDraft }
    )

    expect(outcome).toBe('acknowledgement_failed')
    expect(send).toHaveBeenCalledTimes(1)
    expect(addDraft).toHaveBeenCalledTimes(1)
    expect(addDraft.mock.calls[0][0].policyDecision.rationale).toContain('Neutral acknowledgement failed (SMTP unavailable)')
    expect(addDraft.mock.calls[0][0].status).toBe('escalated')
  })
})
