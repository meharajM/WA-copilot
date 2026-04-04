import type { SerializedSession } from './ChatPersistenceService'

export interface IntelligenceStatsSnapshot {
  totalQueries: number
  resolvedQueries: number
  autonomyRate: number
  trainingCount: number
  learningCount: number
}

export interface DailyTopicBreakdown {
  name: string
  count: number
  percent: number
}

export interface DailyReport {
  version: 1
  date: string
  generatedAt: string
  period: {
    startMs: number
    endMs: number
  }
  metrics: {
    totalConversations: number
    resolvedConversations: number
    unresolvedConversations: number
    activeLeads: number
    messagesReceived: number
    messagesSent: number
    totalMessages: number
    autonomyRate: number
  }
  topics: DailyTopicBreakdown[]
  highlights: string[]
  summaryText: string
}

export function getLocalDayKey(referenceDate = new Date()): string {
  const year = referenceDate.getFullYear()
  const month = String(referenceDate.getMonth() + 1).padStart(2, '0')
  const day = String(referenceDate.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getLocalDayBounds(referenceDate = new Date()): { startMs: number; endMs: number } {
  const start = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
    0,
    0,
    0,
    0
  )
  const end = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
    23,
    59,
    59,
    999
  )
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function isInWindow(ts: number, startMs: number, endMs: number): boolean {
  return ts >= startMs && ts <= endMs
}

function normalizeTopic(topic?: string | null): string | null {
  const cleaned = topic?.trim()
  return cleaned ? cleaned : null
}

function buildSummaryText(
  dateKey: string,
  metrics: DailyReport['metrics'],
  topics: DailyTopicBreakdown[]
): string {
  const topTopic = topics[0]
  const lines = [
    `Daily Summary (${dateKey})`,
    `- Conversations: ${metrics.totalConversations} (${metrics.resolvedConversations} resolved, ${metrics.unresolvedConversations} unresolved)`,
    `- Messages: ${metrics.totalMessages} total (${metrics.messagesReceived} inbound, ${metrics.messagesSent} outbound)`,
    `- Active Leads: ${metrics.activeLeads}`,
    `- Autonomy Rate: ${metrics.autonomyRate.toFixed(1)}%`,
  ]

  if (topTopic) {
    lines.push(`- Top Topic: ${topTopic.name} (${topTopic.percent}% of tagged sessions)`)
  }

  return lines.join('\n')
}

function buildHighlights(metrics: DailyReport['metrics'], topics: DailyTopicBreakdown[]): string[] {
  const highlights: string[] = []
  if (topics.length > 0) {
    highlights.push(`Top customer intent was "${topics[0].name}".`)
  }
  if (metrics.unresolvedConversations > 0) {
    highlights.push(`${metrics.unresolvedConversations} conversation(s) remained unresolved and may need manual follow-up.`)
  } else {
    highlights.push('All tracked conversations were resolved today.')
  }
  if (metrics.autonomyRate >= 85) {
    highlights.push('Autonomy remained strong (>=85%).')
  } else {
    highlights.push('Autonomy dipped below 85%; review escalations and knowledge coverage.')
  }
  return highlights
}

export function buildDailyReport(
  sessions: SerializedSession[],
  intelligenceStats: IntelligenceStatsSnapshot,
  referenceDate = new Date()
): DailyReport {
  const date = getLocalDayKey(referenceDate)
  const { startMs, endMs } = getLocalDayBounds(referenceDate)

  const conversations = sessions.filter((session) => {
    const hasMessageInWindow = session.messages.some((msg) =>
      isInWindow(Number(msg.timestamp || 0), startMs, endMs)
    )
    return hasMessageInWindow || isInWindow(Number(session.updatedAt || 0), startMs, endMs)
  })

  const messages = conversations.flatMap((session) =>
    session.messages.filter((msg) => {
      const ts = Number(msg.timestamp || 0)
      return isInWindow(ts, startMs, endMs) && msg.role !== 'system'
    })
  )

  const messagesReceived = messages.filter((m) => m.role === 'user').length
  const messagesSent = messages.filter((m) => m.role === 'assistant').length
  const totalMessages = messages.length

  const resolvedConversations = conversations.filter((s) => s.status === 'resolved').length
  const unresolvedConversations = Math.max(0, conversations.length - resolvedConversations)

  const leadSet = new Set<string>()
  conversations.forEach((session) => {
    const whatsappJid = (session as SerializedSession & { whatsapp_jid?: string }).whatsapp_jid
    const lead = (session.contact_id || whatsappJid || '').trim()
    if (lead) leadSet.add(lead)
  })

  const topicCounts: Record<string, number> = {}
  conversations.forEach((session) => {
    const topic = normalizeTopic(session.topic)
    if (topic) topicCounts[topic] = (topicCounts[topic] || 0) + 1
  })
  const topicTotal = Object.values(topicCounts).reduce((sum, count) => sum + count, 0)
  const topics: DailyTopicBreakdown[] = Object.entries(topicCounts)
    .map(([name, count]) => ({
      name,
      count,
      percent: topicTotal > 0 ? Math.round((count / topicTotal) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  const metrics: DailyReport['metrics'] = {
    totalConversations: conversations.length,
    resolvedConversations,
    unresolvedConversations,
    activeLeads: leadSet.size,
    messagesReceived,
    messagesSent,
    totalMessages,
    autonomyRate: intelligenceStats.autonomyRate,
  }

  return {
    version: 1,
    date,
    generatedAt: new Date().toISOString(),
    period: { startMs, endMs },
    metrics,
    topics,
    highlights: buildHighlights(metrics, topics),
    summaryText: buildSummaryText(date, metrics, topics),
  }
}
