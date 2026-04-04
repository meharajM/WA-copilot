import { app, ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { ChatPersistenceService, type SerializedSession } from './ChatPersistenceService'
import { IntelligenceService, type EvolutionEvent } from './IntelligenceService'
import {
  buildDailyReport,
  getLocalDayKey,
  type DailyReport,
  type IntelligenceStatsSnapshot,
} from './daily-summary-core'

interface DailySummaryDependencies {
  getSessions?: () => SerializedSession[]
  getIntelligenceStats?: () => IntelligenceStatsSnapshot
  logIntelligenceEvent?: (type: EvolutionEvent['type'], event: string, details?: string) => void
  reportDir?: string
}

export class DailySummaryService {
  private static instance: DailySummaryService
  private readonly reportDir: string

  constructor(private readonly deps: DailySummaryDependencies = {}) {
    this.reportDir = deps.reportDir ?? path.join(app.getPath('userData'), 'reports', 'daily')
  }

  static getInstance(): DailySummaryService {
    if (!DailySummaryService.instance) {
      DailySummaryService.instance = new DailySummaryService()
    }
    return DailySummaryService.instance
  }

  private ensureReportDir(): void {
    if (!fs.existsSync(this.reportDir)) {
      fs.mkdirSync(this.reportDir, { recursive: true })
    }
  }

  private getSessions(): SerializedSession[] {
    return this.deps.getSessions?.() ?? ChatPersistenceService.getInstance().getAllSessions()
  }

  private getIntelligenceStats(): IntelligenceStatsSnapshot {
    return this.deps.getIntelligenceStats?.() ?? IntelligenceService.getInstance().getStats()
  }

  private logEvent(event: string, details?: string): void {
    if (this.deps.logIntelligenceEvent) {
      this.deps.logIntelligenceEvent('learning', event, details)
      return
    }
    IntelligenceService.getInstance().logEvent('learning', event, details)
  }

  private markdownFromReport(report: DailyReport): string {
    const topicLines =
      report.topics.length > 0
        ? report.topics.map((topic) => `- ${topic.name}: ${topic.count} (${topic.percent}%)`).join('\n')
        : '- No topic tags recorded.'

    const highlightLines = report.highlights.map((line) => `- ${line}`).join('\n')

    return [
      `# Daily Report - ${report.date}`,
      '',
      `Generated at: ${report.generatedAt}`,
      '',
      '## Summary',
      report.summaryText,
      '',
      '## Highlights',
      highlightLines,
      '',
      '## Topic Breakdown',
      topicLines,
      '',
      '## Metrics',
      `- Total Conversations: ${report.metrics.totalConversations}`,
      `- Resolved Conversations: ${report.metrics.resolvedConversations}`,
      `- Unresolved Conversations: ${report.metrics.unresolvedConversations}`,
      `- Active Leads: ${report.metrics.activeLeads}`,
      `- Messages Received: ${report.metrics.messagesReceived}`,
      `- Messages Sent: ${report.metrics.messagesSent}`,
      `- Total Messages: ${report.metrics.totalMessages}`,
      `- Autonomy Rate: ${report.metrics.autonomyRate.toFixed(1)}%`,
      '',
    ].join('\n')
  }

  generateDaily(referenceDate = new Date()): {
    success: boolean
    report?: DailyReport
    jsonPath?: string
    markdownPath?: string
    error?: string
  } {
    try {
      if (Number.isNaN(referenceDate.getTime())) {
        return { success: false, error: 'Invalid reference date' }
      }

      this.ensureReportDir()
      const report = buildDailyReport(this.getSessions(), this.getIntelligenceStats(), referenceDate)
      const dateKey = getLocalDayKey(referenceDate)

      const jsonPath = path.join(this.reportDir, `${dateKey}.json`)
      const markdownPath = path.join(this.reportDir, `${dateKey}.md`)

      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')
      fs.writeFileSync(markdownPath, this.markdownFromReport(report), 'utf8')

      this.logEvent('daily_summary_generated', `Generated report for ${dateKey}`)

      return { success: true, report, jsonPath, markdownPath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  listDaily(limit = 30): { success: boolean; reports?: string[]; error?: string } {
    try {
      this.ensureReportDir()
      const files = fs
        .readdirSync(this.reportDir)
        .filter((name) => name.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, Math.max(1, limit))
      return { success: true, reports: files }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  getByDate(dateKey: string): { success: boolean; report?: DailyReport; path?: string; error?: string } {
    try {
      const sanitizedKey = dateKey.replace(/[^0-9-]/g, '')
      if (!sanitizedKey) {
        return { success: false, error: 'Invalid date key' }
      }
      const reportPath = path.join(this.reportDir, `${sanitizedKey}.json`)
      if (!fs.existsSync(reportPath)) {
        return { success: false, error: 'Report not found' }
      }
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as DailyReport
      return { success: true, report, path: reportPath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  getLatest(): { success: boolean; report?: DailyReport; path?: string; error?: string } {
    const list = this.listDaily(1)
    if (!list.success) return { success: false, error: list.error }
    const latest = list.reports?.[0]
    if (!latest) return { success: false, error: 'No reports generated yet' }
    return this.getByDate(latest.replace(/\.json$/, ''))
  }

  async openReportsFolder(): Promise<{ success: boolean; error?: string }> {
    try {
      this.ensureReportDir()
      const shellResult = await shell.openPath(this.reportDir)
      if (shellResult) {
        return { success: false, error: shellResult }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  registerIpc(): void {
    ipcMain.handle('report:generate-daily', async (_event, dateIso?: string) => {
      const date = dateIso ? new Date(dateIso) : new Date()
      return this.generateDaily(date)
    })

    ipcMain.handle('report:list-daily', async (_event, limit?: number) => {
      return this.listDaily(limit ?? 30)
    })

    ipcMain.handle('report:get-by-date', async (_event, dateKey: string) => {
      return this.getByDate(dateKey)
    })

    ipcMain.handle('report:get-latest', async () => {
      return this.getLatest()
    })

    ipcMain.handle('report:open-folder', async () => {
      return await this.openReportsFolder()
    })
  }
}
