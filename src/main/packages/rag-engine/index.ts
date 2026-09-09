import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { IntelligenceService } from '../../services/IntelligenceService'

import { GeminiClient } from '../core/index'

const execAsync = promisify(exec)

export interface RAGChunk {
    id: number
    file_path: string
    file_name: string
    content: string
    rank?: number
}

export function buildFtsQuery(query: string): string {
    return query.normalize('NFKC')
        .replace(/[^\p{L}\p{M}\p{N}_]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(term => `"${term.replaceAll('"', '""')}"`)
        .join(' ')
}

/**
 * @copilot/rag-engine
 * 
 * A high-performance, modular RAG engine for local business knowledge.
 * Features:
 * - FTS5 Full-Text Search
 * - Multimodal Ingestion (OCR/Transcription via Gemini)
 * - 'markitdown' integration for doc-to-md conversion
 */
export class RAGEngine {
    private static instance: RAGEngine
    private db: Database.Database
    private gemini: GeminiClient | null = null

    private constructor() {
        const dbPath = path.join(app.getPath('userData'), 'rag_knowledge.db')
        this.db = new Database(dbPath)
        this.initSchema()

        if (process.env.GOOGLE_API_KEY) {
            this.gemini = new GeminiClient(process.env.GOOGLE_API_KEY)
        }
    }

    static getInstance(): RAGEngine {
        if (!RAGEngine.instance) {
            RAGEngine.instance = new RAGEngine()
        }
        return RAGEngine.instance
    }

    health(): { status: 'ready' | 'error'; documents: number; error?: string } {
        try {
            const documents = (this.db.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count
            return { status: 'ready', documents }
        } catch (error) {
            return { status: 'error', documents: 0, error: error instanceof Error ? error.message : String(error) }
        }
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
                content,
                content='documents',
                content_rowid='id'
            );

            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, content) VALUES('delete', old.id, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, content) VALUES('delete', old.id, old.content);
                INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
            END;
        `)
    }

    async ingestFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' }
        }

        const ext = path.extname(filePath).toLowerCase()
        const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext)

        try {
            const fileName = path.basename(filePath)
            IntelligenceService.getInstance().logEvent('training', 'started', `Ingesting ${isImage ? 'image' : 'document'}: ${fileName}`)
            
            let content = ''

            if (isImage) {
                if (!this.gemini) {
                    return { success: false, error: 'GOOGLE_API_KEY not found. Image transcription requires an API key.' }
                }
                content = await this.gemini.transcribeImage(filePath)
            } else {
                try {
                    const { stdout, stderr } = await execAsync(`uvx --with "markitdown[all]" markitdown "${filePath}"`, {
                        env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:${process.env.HOME || process.env.USERPROFILE}/.local/bin:${process.env.HOME || process.env.USERPROFILE}/.cargo/bin` },
                        timeout: 120_000, // 2 minutes max per document
                        maxBuffer: 50 * 1024 * 1024 // 50MB output buffer
                    })
                    
                    if (stderr && !stdout) {
                        console.warn(`[RAGEngine] markitdown produced stderr but no stdout:`, stderr)
                    }

                    content = stdout.trim()
                } catch (execError: any) {
                    const errMsg = `markitdown conversion failed: ${execError.stderr || execError.message}`
                    IntelligenceService.getInstance().logEvent('training', 'accuracy', `FAILED: ${fileName} - ${errMsg}`)
                    return { success: false, error: errMsg }
                }
            }

            if (!content) {
                return { success: false, error: `Conversion produced no content. Make sure the file is not empty or corrupted.` }
            }

            this.db.prepare('DELETE FROM documents WHERE file_path = ?').run(filePath)
            this.db.prepare('INSERT INTO documents (file_path, file_name, content) VALUES (?, ?, ?)')
                .run(filePath, fileName, content)

            IntelligenceService.getInstance().logEvent('training', 'completed', `Successfully indexed ${fileName}`)
            return { success: true, content }
        } catch (error) {
            console.error(`[RAGEngine] Ingestion failed for ${filePath}:`, error)
            return { success: false, error: String(error) }
        }
    }

    async search(query: string, limit: number = 5): Promise<RAGChunk[]> {
        const cleanQuery = buildFtsQuery(query)
        if (!cleanQuery) return []

        const rows = this.db.prepare(`
            SELECT documents.id, documents.file_path, documents.file_name, documents.content, documents_fts.rank
            FROM documents_fts
            JOIN documents ON documents.id = documents_fts.rowid
            WHERE documents_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        `).all(cleanQuery, limit) as RAGChunk[]

        return rows
    }

    getAllDocuments(): any[] {
        return this.db.prepare('SELECT id, file_path, file_name, created_at FROM documents ORDER BY created_at DESC').all() as any[]
    }

    deleteDocument(id: number): boolean {
        try {
            this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
            return true
        } catch (error) {
            console.error(`[RAGEngine] Failed to delete document ${id}:`, error)
            return false
        }
    }

    async getStats() {
        const countRow = this.db.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number }
        const typeRows = this.db.prepare('SELECT file_name FROM documents').all() as { file_name: string }[]
        
        const fileTypes: Record<string, number> = {}
        typeRows.forEach(row => {
            const ext = row.file_name.split('.').pop()?.toLowerCase() || 'unknown'
            fileTypes[ext] = (fileTypes[ext] || 0) + 1
        })

        const sizeRow = this.db.prepare('SELECT SUM(LENGTH(content)) as total FROM documents').get() as { total: number }
        return { count: countRow.count, fileTypes, totalSize: sizeRow.total || 0 }
    }

    /**
     * Directly ingest raw text into the knowledge base.
     */
    async ingestText(fileName: string, content: string): Promise<{ success: boolean; id?: number; error?: string }> {
        try {
            const filePath = `internal://${fileName}`
            const result = this.db.prepare('INSERT INTO documents (file_path, file_name, content) VALUES (?, ?, ?)')
                .run(filePath, fileName, content)
            
            IntelligenceService.getInstance().logEvent('training', 'completed', `Successfully learned from text: ${fileName}`)
            return { success: true, id: result.lastInsertRowid as number }
        } catch (error) {
            console.error(`[RAGEngine] Text ingestion failed for ${fileName}:`, error)
            return { success: false, error: String(error) }
        }
    }
}
