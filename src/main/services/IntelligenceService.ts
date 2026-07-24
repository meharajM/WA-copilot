import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

export interface AnalyticsRow {
    sessionId: string;
    topic: string;
    messageCount: number;
    timestamp: string;
}

export interface EvolutionEvent {
    id?: number
    type: 'training' | 'learning' | 'accuracy'
    event: string
    details?: string
    timestamp?: string
}

export class IntelligenceService {
    private static instance: IntelligenceService
    private db: Database.Database

    private constructor() {
        const dbPath = path.join(app.getPath('userData'), 'intelligence.db')
        this.db = new Database(dbPath)
        this.initSchema()
    }

    static getInstance(): IntelligenceService {
        if (!IntelligenceService.instance) {
            IntelligenceService.instance = new IntelligenceService()
        }
        return IntelligenceService.instance
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS evolution_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                event TEXT NOT NULL,
                details TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `)
    }

    logEvent(type: 'training' | 'learning' | 'accuracy', event: string, details?: string) {
        try {
            console.log(`[Intelligence] ${type.toUpperCase()}: ${event} - ${details || ''}`)
            this.db.prepare('INSERT INTO evolution_logs (type, event, details) VALUES (?, ?, ?)')
                .run(type, event, details)
        } catch (err) {
            console.error('[Intelligence] Failed to log event:', err)
        }
    }

    getRecentLogs(limit: number = 20): EvolutionEvent[] {
        try {
            return this.db.prepare('SELECT * FROM evolution_logs ORDER BY timestamp DESC LIMIT ?')
                .all(limit) as EvolutionEvent[]
        } catch (err) {
            console.error('[Intelligence] Failed to get logs:', err)
            return []
        }
    }

    getStats() {
        try {
            const total = this.db.prepare("SELECT COUNT(*) as count FROM evolution_logs WHERE type = 'accuracy'").get() as { count: number }
            const resolved = this.db.prepare("SELECT COUNT(*) as count FROM evolution_logs WHERE type = 'accuracy' AND event = 'resolved'").get() as { count: number }
            
            const trainingTotal = this.db.prepare("SELECT COUNT(*) as count FROM evolution_logs WHERE type = 'training'").get() as { count: number }
            const learningTotal = this.db.prepare("SELECT COUNT(*) as count FROM evolution_logs WHERE type = 'learning'").get() as { count: number }

            return {
                totalQueries: total.count,
                resolvedQueries: resolved.count,
                autonomyRate: total.count > 0 ? (resolved.count / total.count) * 100 : 100,
                trainingCount: trainingTotal.count,
                learningCount: learningTotal.count
            }
        } catch (err) {
            console.error('[Intelligence] Failed to get stats:', err)
            return { totalQueries: 0, resolvedQueries: 0, autonomyRate: 100, trainingCount: 0, learningCount: 0 }
        }
    }

    saveToAnalyticsCsv(sessionId: string, topic: string, messageCount: number) {
        try {
            const csvPath = path.join(app.getPath('userData'), 'analytics.csv')
            const fileExists = fs.existsSync(csvPath)
            
            const timestamp = new Date().toISOString()
            // simple safe escape
            const safeTopic = topic ? topic.replace(/"/g, '""') : 'Unknown'
            const row = `"${sessionId}","${safeTopic}",${messageCount},"${timestamp}"\n`
            
            if (!fileExists) {
                fs.writeFileSync(csvPath, 'sessionId,topic,messageCount,timestamp\n', 'utf8')
            }
            fs.appendFileSync(csvPath, row, 'utf8')
            console.log(`[Intelligence] Saved to CSV: ${sessionId} -> ${topic}`)
        } catch (err) {
            console.error('[Intelligence] Failed to write to analytics CSV:', err)
        }
    }

    getAnalyticsCsv(): AnalyticsRow[] {
        try {
            const csvPath = path.join(app.getPath('userData'), 'analytics.csv')
            if (!fs.existsSync(csvPath)) return []
            
            const content = fs.readFileSync(csvPath, 'utf8')
            const lines = content.trim().split('\n')
            if (lines.length <= 1) return [] // Only headers
            
            return lines.slice(1).map(line => {
                const match = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)
                if (!match) return null
                
                const cols = match.map(m => m.replace(/^,/, '').replace(/(^"|"$)/g, '').replace(/""/g, '"'))
                
                return {
                    sessionId: cols[0],
                    topic: cols[1],
                    messageCount: parseInt(cols[2], 10) || 0,
                    timestamp: cols[3]
                }
            }).filter(Boolean) as AnalyticsRow[]
            
        } catch (err) {
            console.error('[Intelligence] Failed to read analytics CSV:', err)
            return []
        }
    }

    registerIpc() {
        ipcMain.handle('intelligence:get-logs', async (_event, limit: number) => {
            return { success: true, logs: this.getRecentLogs(limit) }
        })

        ipcMain.handle('intelligence:get-stats', async () => {
            return { success: true, stats: this.getStats() }
        })

        ipcMain.handle('intelligence:log-accuracy', async (_event, { event, details }) => {
            this.logEvent('accuracy', event, details)
            return { success: true }
        })

        ipcMain.handle('intelligence:save-analytics-csv', async (_event, { sessionId, topic, messageCount }) => {
            this.saveToAnalyticsCsv(sessionId, topic, messageCount)
            return { success: true }
        })

        ipcMain.handle('intelligence:get-analytics-csv', async () => {
            return { success: true, data: this.getAnalyticsCsv() }
        })
    }
}
