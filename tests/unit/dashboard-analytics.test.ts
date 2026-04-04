import { describe, expect, it } from 'vitest'
import type { ChatSession } from '../../src/renderer/src/stores/chatStore'
import {
  computeConversationInsights,
  computeDashboardMetrics,
} from '../../src/renderer/src/lib/dashboard-analytics'

function makeSession(partial: Partial<ChatSession>): ChatSession {
  const now = Date.now()
  return {
    id: partial.id ?? 's1',
    title: partial.title ?? 'Session',
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

describe('dashboard analytics helpers', () => {
  it('computes KPI metrics using recent non-system messages and unique lead identifiers', () => {
    const now = Date.now()
    const sessions: ChatSession[] = [
      makeSession({
        id: 'wa-1',
        updatedAt: now - 60_000,
        whatsapp_jid: '14155550000@s.whatsapp.net',
        messages: [
          { id: 'm1', role: 'system', content: 'meta', timestamp: now - 60_000 },
          { id: 'm2', role: 'user', content: 'hello', timestamp: now - 50_000 },
          { id: 'm3', role: 'assistant', content: 'hi', timestamp: now - 40_000 },
        ],
      }),
      makeSession({
        id: 'omni-1',
        updatedAt: now - 120_000,
        contact_id: 'user@example.com',
        messages: [{ id: 'm4', role: 'assistant', content: 'email update', timestamp: now - 110_000 }],
      }),
      makeSession({
        id: 'old',
        updatedAt: now - 26 * 60 * 60 * 1000,
        whatsapp_jid: '14155551111@s.whatsapp.net',
        messages: [{ id: 'm5', role: 'user', content: 'old', timestamp: now - 26 * 60 * 60 * 1000 }],
      }),
    ]

    const metrics = computeDashboardMetrics(
      sessions,
      { count: 7, fileTypes: {}, totalSize: 0 },
      { entityCount: 5, relationCount: 0 },
      { totalQueries: 10, resolvedQueries: 9, autonomyRate: 92.34, trainingCount: 0, learningCount: 0 },
      now
    )

    expect(metrics.messagesToday).toBe(3)
    expect(metrics.activeLeads).toBe(3)
    expect(metrics.knowledgeDocs).toBe(7)
    expect(metrics.memoryFacts).toBe(5)
    expect(metrics.dataPoints).toBe(12)
    expect(metrics.autonomyRate).toBe('92.3')
  })

  it('returns stable fallback topic distribution when no analyzed topics exist', () => {
    const insights = computeConversationInsights([], 3)
    expect(insights).toEqual([
      { name: 'Product Queries', percent: 45 },
      { name: 'Order Status', percent: 35 },
      { name: 'Returns/Refunds', percent: 20 },
    ])
  })

  it('aggregates analyzed topics and returns top 3 by percentage', () => {
    const sessions: ChatSession[] = [
      makeSession({ id: 's1', topic: 'Order Status' }),
      makeSession({ id: 's2', topic: 'Order Status' }),
      makeSession({ id: 's3', topic: 'Product Queries' }),
      makeSession({ id: 's4', topic: 'Returns/Refunds' }),
      makeSession({ id: 's5', topic: 'Returns/Refunds' }),
      makeSession({ id: 's6', topic: 'Technical Support' }),
    ]

    const insights = computeConversationInsights(sessions, 20)
    expect(insights).toEqual([
      { name: 'Order Status', percent: 33 },
      { name: 'Returns/Refunds', percent: 33 },
      { name: 'Product Queries', percent: 17 },
    ])
  })
})
