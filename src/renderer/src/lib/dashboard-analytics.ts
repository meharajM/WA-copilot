import type { ChatSession } from '../stores/chatStore'

export interface RagStatsSnapshot {
  count: number
  fileTypes: Record<string, number>
  totalSize: number
}

export interface MemoryStatsSnapshot {
  entityCount: number
  relationCount: number
}

export interface IntelligenceStatsSnapshot {
  totalQueries: number
  resolvedQueries: number
  autonomyRate: number
  trainingCount: number
  learningCount: number
}

export interface DashboardMetrics {
  messagesToday: number
  activeLeads: number
  knowledgeDocs: number
  memoryFacts: number
  dataPoints: number
  autonomyRate: string
}

export interface ConversationInsight {
  name: string
  percent: number
}

export function computeDashboardMetrics(
  sessions: ChatSession[],
  ragStats: RagStatsSnapshot,
  memoryStats: MemoryStatsSnapshot,
  intelligenceStats: IntelligenceStatsSnapshot,
  now = Date.now()
): DashboardMetrics {
  const oneDayAgo = now - 24 * 60 * 60 * 1000

  let messagesToday = 0
  const uniqueLeads = new Set<string>()

  sessions.forEach((session) => {
    if (session.updatedAt > oneDayAgo) {
      messagesToday += session.messages.filter((m) => m.role !== 'system').length
    }

    const leadKey = session.contact_id || session.whatsapp_jid
    if (leadKey) uniqueLeads.add(leadKey)
  })

  return {
    messagesToday,
    activeLeads: uniqueLeads.size,
    knowledgeDocs: ragStats.count,
    memoryFacts: memoryStats.entityCount,
    dataPoints: ragStats.count + memoryStats.entityCount,
    autonomyRate: intelligenceStats.autonomyRate.toFixed(1),
  }
}

export function computeConversationInsights(
  sessions: ChatSession[],
  messagesToday: number
): ConversationInsight[] {
  const topicsLog = sessions.map((s) => s.topic).filter(Boolean) as string[]

  // If no sessions were analyzed yet, use a stable fallback mix for the chart.
  if (topicsLog.length === 0) {
    const total = Math.max(messagesToday, 10)
    return [
      { name: 'Product Queries', percent: Math.round((total * 0.45) / total * 100) },
      { name: 'Order Status', percent: Math.round((total * 0.35) / total * 100) },
      { name: 'Returns/Refunds', percent: Math.round((total * 0.2) / total * 100) },
    ]
  }

  const counts: Record<string, number> = {}
  topicsLog.forEach((topic) => {
    counts[topic] = (counts[topic] || 0) + 1
  })

  const total = topicsLog.length
  return Object.entries(counts)
    .map(([name, count]) => ({ name, percent: Math.round((count / total) * 100) }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3)
}

