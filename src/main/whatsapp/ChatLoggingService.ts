import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export interface ChatMessage {
    id: string
    from_jid: string
    to_jid: string
    content: string
    timestamp: number
    type: string
    is_from_me: number
    media_url?: string
}

export class ChatLoggingService {
    private db: Database.Database

    constructor() {
        const dbPath = path.join(app.getPath('userData'), 'chats.db')
        
        // Ensure directory exists
        const dbDir = path.dirname(dbPath)
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true })
        }

        this.db = new Database(dbPath)
        this.initSchema()
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                from_jid TEXT NOT NULL,
                to_jid TEXT NOT NULL,
                content TEXT,
                timestamp INTEGER NOT NULL,
                type TEXT NOT NULL,
                is_from_me INTEGER NOT NULL,
                media_url TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_from_jid ON messages(from_jid);
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        `)
    }

    public logMessage(msg: ChatMessage) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO messages (id, from_jid, to_jid, content, timestamp, type, is_from_me, media_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        stmt.run(
            msg.id,
            msg.from_jid,
            msg.to_jid,
            msg.content,
            msg.timestamp,
            msg.type,
            msg.is_from_me,
            msg.media_url || null
        )
    }

    public getRecentMessages(jid: string, limit: number = 50): ChatMessage[] {
        const stmt = this.db.prepare(`
            SELECT * FROM messages 
            WHERE from_jid = ? OR to_jid = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `)
        return stmt.all(jid, jid, limit) as ChatMessage[]
    }
}

export const chatLoggingService = new ChatLoggingService()
