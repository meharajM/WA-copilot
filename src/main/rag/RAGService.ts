import { RAGEngine, type RAGChunk } from '../packages/rag-engine/index'
import { BusinessPersona } from '../packages/persona/index'

export type { RAGChunk }

export class RAGService {
    private static instance: RAGService

    private constructor() {
        // RAGEngine initializes its own DB and Gemini client
    }

    static getInstance(): RAGService {
        if (!RAGService.instance) {
            RAGService.instance = new RAGService()
        }
        return RAGService.instance
    }

    /**
     * Ingest a file into the RAG index.
     */
    async ingestFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
        const result = await RAGEngine.getInstance().ingestFile(filePath)
        if (result.success && result.content) {
            // Dynamically learn the business profile from new information
            BusinessPersona.getInstance().identifyBusinessFromContext(result.content).catch(err => {
                console.error('[RAGService] Failed to update business persona from ingestion:', err);
            })
        }
        return result
    }

    /**
     * Directly save a corrected Q&A pair as a knowledge snippet.
     */
    async saveCorrection(question: string, answer: string): Promise<{ success: boolean; id?: number }> {
        const snippet = `Question: ${question}\nCorrect Answer: ${answer}`;
        const fileName = `correction_${Date.now()}.txt`;
        return RAGEngine.getInstance().ingestText(fileName, snippet);
    }

    /**
     * Search the business knowledge base.
     */
    async search(query: string, limit: number = 5): Promise<RAGChunk[]> {
        return RAGEngine.getInstance().search(query, limit)
    }

    async getStats(): Promise<{ count: number; fileTypes: Record<string, number>; totalSize: number }> {
        return RAGEngine.getInstance().getStats()
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
                },
                {
                    name: 'rag_get_stats',
                    description: 'Get detailed statistics about the indexed knowledge base (file types, size, etc.).',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'rag_save_correction',
                    description: 'Save a corrected answer to the brain so the agent learns for next time.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            question: { type: 'string', description: 'The original user question' },
                            answer: { type: 'string', description: 'The corrected/approved answer' }
                        },
                        required: ['question', 'answer']
                    }
                }
            ]
        }
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; error?: string }> {
        try {
            switch (name) {
                case 'rag_search': {
                    const results = await this.search(args.query as string, args.limit as number)
                    return { result: results }
                }
                case 'rag_ingest': {
                    console.log(`[RAG Tool] Starting ingestion for: ${args.filePath}`)
                    const outcome = await this.ingestFile(args.filePath as string)
                    if (!outcome.success) {
                        console.error(`[RAG Tool] Ingestion FAILED: ${outcome.error}`)
                        return { result: null, error: outcome.error }
                    }
                    console.log(`[RAG Tool] Ingestion SUCCESSFUL: ${args.filePath}`)
                    return { result: outcome }
                }
                case 'rag_get_stats': {
                    const stats = await this.getStats()
                    return { result: stats }
                }
                case 'rag_save_correction': {
                    const outcome = await this.saveCorrection(args.question as string, args.answer as string)
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
