import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface RAGChunk {
    id: number
    file_path: string
    file_name: string
    content: string
    rank?: number
}

export class RAGService {
    private static instance: RAGService
    private db: Database.Database

    private constructor() {
        const dbPath = path.join(app.getPath('userData'), 'rag_knowledge.db')
        this.db = new Database(dbPath)
        this.initSchema()
    }

    static getInstance(): RAGService {
        if (!RAGService.instance) {
            RAGService.instance = new RAGService()
        }
        return RAGService.instance
    }

    private initSchema() {
        // Use FTS5 for lightning fast full-text search
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

            -- Triggers to kept FTS index in sync
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

    /**
     * Ingest a file (PDF, TXT, DOCX, etc.) into the RAG index.
     * Uses 'uvx markitdown' for high-quality Markdown conversion.
     */
    async ingestFile(filePath: string): Promise<{ success: boolean; error?: string }> {
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' }
        }

        try {
            console.log(`[RAG] Ingesting: ${filePath}`)
            
            // 1. Convert to Markdown using markitdown
            // We use uvx for zero-config execution of the markitdown CLI
            const { stdout, stderr } = await execAsync(`uvx markitdown "${filePath}"`, {
                env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` }
            })

            const content = stdout.trim()
            if (!content) {
                return { success: false, error: `Conversion produced no content. Stderr: ${stderr}` }
            }

            // 2. Clear existing entries for this file to avoid duplicates
            this.db.prepare('DELETE FROM documents WHERE file_path = ?').run(filePath)

            // 3. Store in SQLite (FTS trigger handles the rest)
            const fileName = path.basename(filePath)
            
            // For very large files, we could chunk them here. 
            // For now, we store the full content per file for simplicity if files are reasonably sized business docs.
            // If the user wants "faster", we can implement chunking later.
            this.db.prepare('INSERT INTO documents (file_path, file_name, content) VALUES (?, ?, ?)')
                .run(filePath, fileName, content)

            console.log(`[RAG] Successfully indexed ${fileName}`)
            return { success: true }
        } catch (error) {
            console.error(`[RAG] Ingestion failed for ${filePath}:`, error)
            return { success: false, error: String(error) }
        }
    }

    /**
     * Search the business knowledge base using FTS5.
     */
    async search(query: string, limit: number = 5): Promise<RAGChunk[]> {
        try {
            // BM25-like ranking via FTS5 'rank'
            const stmt = this.db.prepare(`
                SELECT id, file_path, file_name, content, rank
                FROM documents_fts
                JOIN documents ON documents.id = documents_fts.rowid
                WHERE documents_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            `)
            
            // Clean query to be FTS5 compatible (remove special chars)
            const cleanQuery = query.replace(/[^\w\s]/g, ' ').trim()
            if (!cleanQuery) return []

            const results = stmt.all(cleanQuery, limit) as RAGChunk[]
            return results
        } catch (error) {
            console.error(`[RAG] Search failed for "${query}":`, error)
            return []
        }
    }

    async clearAll(): Promise<void> {
        this.db.exec('DELETE FROM documents; DELETE FROM documents_fts;')
    }

    listTools() {
        return {
            tools: [
                {
                    name: 'rag_search',
                    description: 'Search the local business knowledge base (PDFs, docs, manuals). Use this to answer enterprise-specific questions.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'The knowledge search query' },
                            limit: { type: 'number', description: 'Max results (default 5)' }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'rag_ingest',
                    description: 'Manually add a local file to the knowledge base.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filePath: { type: 'string', description: 'Absolute path to the file' }
                        },
                        required: ['filePath']
                    }
                }
            ]
        }
    }

    async callTool(name: string, args: any): Promise<{ result: any; error?: string }> {
        try {
            switch (name) {
                case 'rag_search': {
                    const results = await this.search(args.query, args.limit)
                    return { result: results }
                }
                case 'rag_ingest': {
                    const outcome = await this.ingestFile(args.filePath)
                    if (!outcome.success) return { result: null, error: outcome.error }
                    return { result: outcome }
                }
                default:
                    return { result: null, error: `Unknown RAG tool: ${name}` }
            }
        } catch (error) {
            return { result: null, error: String(error) }
        }
    }
}
