import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'

export interface SerializedSession {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    channel?: string
    contact_id?: string
    status?: string
    workspacePath?: string
    topic?: string
    messages: any[]
}

export class ChatPersistenceService {
    private static instance: ChatPersistenceService
    private db: Database.Database

    private constructor() {
        const dbPath = path.join(app.getPath('userData'), 'chat_history.v2.db')
        
        const dbDir = path.dirname(dbPath)
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true })
        }

        this.db = new Database(dbPath)
        this.initSchema()
    }

    public static getInstance(): ChatPersistenceService {
        if (!ChatPersistenceService.instance) {
            ChatPersistenceService.instance = new ChatPersistenceService()
        }
        return ChatPersistenceService.instance
    }

    private initSchema() {
        // Table for sessions (metadata)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                channel TEXT,
                contact_id TEXT,
                status TEXT,
                workspacePath TEXT,
                topic TEXT,
                extra_data TEXT -- JSON blob for future expansions
            );
            
            -- Table for messages linked to sessions
            CREATE TABLE IF NOT EXISTS session_messages (
                id TEXT PRIMARY KEY,
                sessionId TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                timestamp INTEGER NOT NULL,
                thought TEXT,
                toolCalls TEXT, -- JSON blob
                actions TEXT,    -- JSON blob
                findings TEXT,   -- JSON blob
                plan TEXT,       -- JSON blob (ExecutionPlan)
                FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_session_messages_sessionId ON session_messages(sessionId);
            CREATE INDEX IF NOT EXISTS idx_sessions_updatedAt ON sessions(updatedAt);
        `)
    }

    public saveSession(session: SerializedSession) {
        const transaction = this.db.transaction(() => {
            // 1. Save/Update Session Metadata
            const sessionStmt = this.db.prepare(`
                INSERT OR REPLACE INTO sessions (id, title, createdAt, updatedAt, channel, contact_id, status, workspacePath, topic)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            sessionStmt.run(
                session.id,
                session.title,
                session.createdAt,
                session.updatedAt,
                session.channel || null,
                session.contact_id || null,
                session.status || 'active',
                session.workspacePath || null,
                session.topic || null
            )

            // 2. Save Messages
            // Clear existing messages for this session to handle updates/deletes simply 
            // (or we could INSERT OR REPLACE if we had reliable message IDs)
            this.db.prepare('DELETE FROM session_messages WHERE sessionId = ?').run(session.id)
            
            const msgStmt = this.db.prepare(`
                INSERT INTO session_messages (id, sessionId, role, content, timestamp, thought, toolCalls, actions, findings, plan)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)

            for (const msg of session.messages) {
                msgStmt.run(
                    msg.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    session.id,
                    msg.role,
                    msg.content,
                    msg.timestamp || Date.now(),
                    msg.thought || null,
                    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
                    msg.actions ? JSON.stringify(msg.actions) : null,
                    msg.findings ? JSON.stringify(msg.findings) : null,
                    msg.plan ? JSON.stringify(msg.plan) : null
                )
            }
        })

        transaction()
    }

    public getAllSessions(): SerializedSession[] {
        const sessions = this.db.prepare('SELECT * FROM sessions ORDER BY updatedAt DESC').all() as any[]
        
        return sessions.map(s => {
            const messages = this.db.prepare('SELECT * FROM session_messages WHERE sessionId = ? ORDER BY timestamp ASC').all(s.id) as any[]
            return {
                ...s,
                messages: messages.map(m => ({
                    ...m,
                    toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
                    actions: m.actions ? JSON.parse(m.actions) : undefined,
                    findings: m.findings ? JSON.parse(m.findings) : undefined,
                    plan: m.plan ? JSON.parse(m.plan) : undefined
                }))
            }
        })
    }

    public deleteSession(id: string) {
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    }

    public registerIpc() {
        ipcMain.handle('chat:save-sessions', async (_event, sessions: SerializedSession[]) => {
            try {
                for (const s of sessions) {
                    this.saveSession(s)
                }
                return { success: true }
            } catch (err) {
                console.error('[ChatPersistence] Save error:', err)
                return { success: false, error: String(err) }
            }
        })

        ipcMain.handle('chat:load-sessions', async () => {
            try {
                return { success: true, sessions: this.getAllSessions() }
            } catch (err) {
                console.error('[ChatPersistence] Load error:', err)
                return { success: false, error: String(err) }
            }
        })

        ipcMain.handle('chat:delete-session', async (_event, id: string) => {
            try {
                this.deleteSession(id)
                return { success: true }
            } catch (err) {
                return { success: false, error: String(err) }
            }
        })
    }
}
