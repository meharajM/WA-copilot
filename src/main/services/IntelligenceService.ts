import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import * as path from 'path'

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
    }
}
