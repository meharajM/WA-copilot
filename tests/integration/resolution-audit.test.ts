import { describe, expect, it } from 'vitest'
import type { ChatSession } from '../../src/renderer/src/stores/chatStore'
import { computeResolutionAuditActions } from '../../src/renderer/src/hooks/useResolutionAudit'

function makeSession(partial: Partial<ChatSession>): ChatSession {
  const now = Date.now()
  return {
    id: partial.id ?? 's1',
    title: partial.title ?? 'Test Session',
    messages: partial.messages ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    status: partial.status ?? 'active',
    whatsapp_jid: partial.whatsapp_jid,
    channel: partial.channel,
    contact_id: partial.contact_id,
    workspacePath: partial.workspacePath,
    progress: partial.progress,
    eta: partial.eta,
    plan: partial.plan,
    topic: partial.topic,
  }
}

describe('resolution audit decision logic', () => {
  it('emits follow-up action when inactivity crosses the threshold and last message is assistant', () => {
    const now = Date.now()
    const sessions: ChatSession[] = [
      makeSession({
        id: 'wa1',
        whatsapp_jid: '14155551212@s.whatsapp.net',
        updatedAt: now - 16 * 60 * 1000,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'Can you confirm?',
            timestamp: now - 12 * 60 * 1000,
          },
        ],
      }),
    ]

    const actions = computeResolutionAuditActions(sessions, now)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'send_followup',
      sessionId: 'wa1',
      whatsappJid: '14155551212@s.whatsapp.net',
    })
  })

  it('does not emit actions when session is below inactivity threshold', () => {
    const now = Date.now()
    const sessions: ChatSession[] = [
      makeSession({
        id: 'wa2',
        whatsapp_jid: '14155550000@s.whatsapp.net',
        updatedAt: now - 2 * 60 * 1000,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'Recent response',
            timestamp: now - 2 * 60 * 1000,
          },
        ],
      }),
    ]

    const actions = computeResolutionAuditActions(sessions, now)
    expect(actions).toHaveLength(0)
  })

  it('emits user-silence log action when last inactive message is from user', () => {
    const now = Date.now()
    const sessions: ChatSession[] = [
      makeSession({
        id: 'wa3',
        whatsapp_jid: '14155559999@s.whatsapp.net',
        updatedAt: now - 15 * 60 * 1000,
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'Hello?',
            timestamp: now - 16 * 60 * 1000,
          },
        ],
      }),
    ]

    const actions = computeResolutionAuditActions(sessions, now)
    expect(actions).toEqual([{ type: 'log_user_silence', sessionId: 'wa3' }])
  })

  it('ignores resolved sessions even if inactive', () => {
    const now = Date.now()
    const sessions: ChatSession[] = [
      makeSession({
        id: 'wa4',
        status: 'resolved',
        whatsapp_jid: '14155558888@s.whatsapp.net',
        updatedAt: now - 30 * 60 * 1000,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'Closing this out',
            timestamp: now - 30 * 60 * 1000,
          },
        ],
      }),
    ]

    const actions = computeResolutionAuditActions(sessions, now)
    expect(actions).toEqual([])
  })
})
