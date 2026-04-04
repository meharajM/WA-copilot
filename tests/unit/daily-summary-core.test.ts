import { describe, expect, it } from 'vitest'
import { buildDailyReport } from '../../src/main/services/daily-summary-core'
import type { SerializedSession } from '../../src/main/services/ChatPersistenceService'

function makeSession(partial: Partial<SerializedSession>): SerializedSession {
  const now = Date.now()
  return {
    id: partial.id ?? 's1',
    title: partial.title ?? 'Session',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    channel: partial.channel,
    contact_id: partial.contact_id,
    status: partial.status ?? 'active',
    workspacePath: partial.workspacePath,
    topic: partial.topic,
    messages: partial.messages ?? [],
  }
}

describe('daily summary core', () => {
  it('builds report metrics/topics from the selected day window', () => {
    const referenceDate = new Date('2026-04-04T12:00:00')
    const inWindowTs = new Date('2026-04-04T10:00:00').getTime()
    const oldTs = new Date('2026-04-03T10:00:00').getTime()

    const sessions: SerializedSession[] = [
      makeSession({
        id: 'wa-1',
        status: 'resolved',
        contact_id: '14155550000@s.whatsapp.net',
        topic: 'Order Status',
        updatedAt: inWindowTs,
        messages: [
          { id: 'm1', role: 'user', content: 'where is my order', timestamp: inWindowTs },
          { id: 'm2', role: 'assistant', content: 'checking', timestamp: inWindowTs + 10_000 },
        ],
      }),
      makeSession({
        id: 'mail-1',
        contact_id: 'lead@example.com',
        topic: 'Returns/Refunds',
        updatedAt: inWindowTs,
        messages: [
          { id: 'm3', role: 'system', content: 'meta', timestamp: inWindowTs },
          { id: 'm4', role: 'user', content: 'refund please', timestamp: inWindowTs + 20_000 },
        ],
      }),
      makeSession({
        id: 'old-1',
        contact_id: '14155551111@s.whatsapp.net',
        updatedAt: oldTs,
        messages: [{ id: 'm5', role: 'user', content: 'old', timestamp: oldTs }],
      }),
    ]

    const report = buildDailyReport(
      sessions,
      {
        totalQueries: 12,
        resolvedQueries: 10,
        autonomyRate: 83.333,
        trainingCount: 2,
        learningCount: 3,
      },
      referenceDate
    )

    expect(report.date).toBe('2026-04-04')
    expect(report.metrics.totalConversations).toBe(2)
    expect(report.metrics.resolvedConversations).toBe(1)
    expect(report.metrics.unresolvedConversations).toBe(1)
    expect(report.metrics.activeLeads).toBe(2)
    expect(report.metrics.messagesReceived).toBe(2)
    expect(report.metrics.messagesSent).toBe(1)
    expect(report.metrics.totalMessages).toBe(3)
    expect(report.metrics.autonomyRate).toBeCloseTo(83.333, 3)

    expect(report.topics).toHaveLength(2)
    expect(report.topics[0].name).toBe('Order Status')
    expect(report.summaryText).toContain('Daily Summary (2026-04-04)')
    expect(report.highlights.length).toBeGreaterThan(0)
  })
})
