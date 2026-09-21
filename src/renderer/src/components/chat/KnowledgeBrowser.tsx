import { Brain, Search, Trash2, FileText, Calendar, Plus, ExternalLink, Zap } from 'lucide-react'
import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import electron from '../../lib/electron'
import { executeToolCall } from '../../lib/mcp'
import { getBrowserAgentdClient, readBrowserKnowledgeBinaryFile, readBrowserKnowledgeFile } from '../../lib/browser-agentd-client'
import { isTauriRuntime } from '../../lib/tauri-native-bridge'

interface Document {
    id: number
    file_path: string
    file_name: string
    created_at: string
    file_type?: string
    size?: number
}

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()

export function KnowledgeBrowser() {
    const [docs, setDocs] = useState<Document[]>([])
    const [search, setSearch] = useState('')
    const [loading, setLoading] = useState(true)
    const [uploading, setUploading] = useState(false)
    const [preview, setPreview] = useState<{ fileName: string; content: string } | null>(null)
    const [previewingId, setPreviewingId] = useState<number | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        fetchDocs()
    }, [])

    const fetchDocs = async () => {
        setLoading(true)
        try {
            const result = await electron.intelligence.getKnowledge()
            setDocs(result)
        } catch (error) {
            console.error('Failed to fetch knowledge:', error)
        } finally {
            setLoading(false)
        }
    }

    const handleDelete = async (id: number) => {
        if (!confirm('Are you sure you want to remove this knowledge from the brain?')) return
        try {
            await electron.intelligence.deleteKnowledge(id)
            setDocs(docs.filter(d => d.id !== id))
        } catch (error) {
            console.error('Failed to delete knowledge:', error)
        }
    }

    const handlePreview = async (doc: Document) => {
        if (!isBrowserProduct()) return
        setPreviewingId(doc.id)
        try {
            const value = await getBrowserAgentdClient().getKnowledgeContent(doc.id)
            setPreview({ fileName: value.document.file_name, content: value.content })
        } catch (error) {
            console.error('Failed to preview knowledge:', error)
            alert(`Preview unavailable: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            setPreviewingId(null)
        }
    }

    const handleAddKnowledge = async () => {
        if (isBrowserProduct()) {
            fileInputRef.current?.click()
            return
        }
        try {
            const filePath = await electron.app.selectFile({
                title: 'Select Knowledge Resource',
                buttonLabel: 'Inject into Brain',
                filters: [
                    { name: 'Documents', extensions: ['pdf', 'txt', 'csv', 'docx', 'xlsx', 'pptx'] },
                    { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }
                ]
            })

            if (!filePath) return

            setUploading(true)
            
            // Call the internal RAG ingestion tool
            // We can use callTool directly on the RAG server if we find it
            const response = await executeToolCall('rag_ingest', { filePath }) as { result?: any; error?: string }
            
            if (response.error) {
                alert(`Failed to ingest: ${response.error}`)
                return
            }

            // The MCP tool results are usually wrapped in result.content[0].text as a JSON string
            let outcome: { success: boolean; error?: string } = { success: false };
            try {
                const text = response.result?.content?.[0]?.text;
                if (text) outcome = JSON.parse(text);
            } catch (e) {
                console.error('[KnowledgeBrowser] Failed to parse tool result:', e);
            }
            
            if (!outcome.success) {
                alert(`Failed to index: ${outcome.error || 'Unknown conversion error'}`)
            } else {
                // Small delay to let SQLite commits flush before UI refresh
                await new Promise(r => setTimeout(r, 500))
                await fetchDocs()
                alert(`Successfully ingested: ${filePath.split('/').pop()}`)
            }
        } catch (error) {
            console.error('Failed to add knowledge:', error)
            alert('An unexpected error occurred during knowledge injection.')
        } finally {
            setUploading(false)
        }
    }

    const handleBrowserFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        const extension = file.name.split('.').pop()?.toLowerCase() || ''
        const isText = file.type.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'xml', 'html', 'log'].includes(extension)
        setUploading(true)
        try {
            const client = getBrowserAgentdClient()
            if (isText) {
                const browserFile = await readBrowserKnowledgeFile(file)
                await client.ingestKnowledge({
                  fileName: file.name,
                  filePath: `browser://knowledge/${encodeURIComponent(file.name)}`,
                  ...browserFile,
                })
            } else {
                const browserFile = await readBrowserKnowledgeBinaryFile(file)
                await client.convertKnowledge({ fileName: file.name, ...browserFile })
            }
            await fetchDocs()
            alert(`Successfully ${isText ? 'ingested' : 'converted and ingested'}: ${file.name}`)
        } catch (error) {
            console.error('Failed to add browser knowledge:', error)
            alert(`Failed to index: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            setUploading(false)
        }
    }

    const filteredDocs = docs.filter(d => 
        d.file_name.toLowerCase().includes(search.toLowerCase())
    )

    return (
        <div className="flex-1 flex flex-col h-full bg-[#0f1115] text-white">
            {/* Header */}
            <header className="p-8 border-b border-white/5 space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-blue-500/20 flex items-center justify-center border border-blue-500/20">
                            <Brain className="w-6 h-6 text-blue-400" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold">Knowledge Brain</h1>
                            <p className="text-gray-400 text-sm">Manage bounded text and document files your agent learns from.</p>
                        </div>
                    </div>
                    <button 
                        onClick={handleAddKnowledge}
                        disabled={uploading}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors"
                    >
                        {uploading ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <Plus className="w-4 h-4" />
                        )}
                        <span>{uploading ? 'Injecting...' : 'Add Knowledge'}</span>
                    </button>
                    {isBrowserProduct() && <input ref={fileInputRef} type="file" hidden accept=".txt,.md,.csv,.json,.xml,.html,.log,.pdf,.docx,.xlsx,.xls,.pptx,text/*" onChange={handleBrowserFile} />}
                </div>

                {/* Stats Bar */}
                <div className="flex gap-4">
                    <div className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 flex items-center gap-2">
                        <Zap className="w-4 h-4 text-yellow-400" />
                        <span className="text-xs font-semibold text-gray-300">{docs.length} Sources Indexed</span>
                    </div>
                    <div className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-green-400" />
                        <span className="text-xs font-semibold text-gray-300">Last update: Just now</span>
                    </div>
                </div>

                {/* Search Bar */}
                <div className="relative max-w-xl">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input 
                        type="text"
                        placeholder="Search indexed documents..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                    />
                </div>
            </header>

            {/* Content */}
            <main className="flex-1 overflow-y-auto p-8">
                {loading ? (
                    <div className="flex flex-col items-center justify-center h-64 gap-4">
                        <div className="w-8 h-8 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                        <p className="text-gray-500 text-sm font-medium">Downloading neural pathways...</p>
                    </div>
                ) : filteredDocs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-center space-y-4">
                        <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center border border-white/10 mb-2">
                            <FileText className="w-8 h-8 text-gray-600" />
                        </div>
                        <h3 className="text-lg font-bold text-gray-400">Empty Brain</h3>
                        <p className="text-gray-500 text-sm max-w-xs">Index bounded text files or convert common PDF, Office, and document formats through the local agent.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredDocs.map((doc) => (
                            <div 
                                key={doc.id}
                                className="group p-5 rounded-3xl bg-white/5 border border-white/10 hover:border-blue-500/30 hover:bg-blue-500/5 transition-all duration-300 space-y-4"
                            >
                                <div className="flex items-start justify-between">
                                    <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center group-hover:bg-blue-500/20 transition-colors">
                                        <FileText className="w-5 h-5 text-gray-400 group-hover:text-blue-400" />
                                    </div>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        {isBrowserProduct() ? <button
                                            onClick={() => void handlePreview(doc)}
                                            disabled={previewingId === doc.id}
                                            title="Preview indexed content"
                                            className="p-2 rounded-lg hover:bg-white/10 transition-colors text-gray-400 hover:text-white disabled:opacity-50"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </button> : <button
                                            onClick={() => electron.openExternal(`file://${doc.file_path}`)}
                                            title="Open file location"
                                            className="p-2 rounded-lg hover:bg-white/10 transition-colors text-gray-400 hover:text-white"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </button>}
                                        <button 
                                            onClick={() => handleDelete(doc.id)}
                                            className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                                <div>
                                    <h4 className="font-bold text-gray-200 truncate">{doc.file_name}</h4>
                                    <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mt-1">
                                        Added on {new Date(doc.created_at).toLocaleDateString()}
                                    </p>
                                </div>
                                <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                                    <span className="text-[10px] font-bold text-blue-400 bg-blue-500/10 px-2 py-1 rounded-md">
                                        100% INDEXED
                                    </span>
                                    <span className="text-[10px] font-medium text-gray-500">
                                        {doc.file_path.split('.').pop()?.toUpperCase()}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </main>
            {preview && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-label={`Preview ${preview.fileName}`}>
                <div className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#171a21] shadow-2xl">
                    <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                        <div>
                            <h2 className="font-semibold text-gray-100">{preview.fileName}</h2>
                            <p className="text-xs text-gray-500">Indexed content preview · native file paths are never exposed</p>
                        </div>
                        <button type="button" onClick={() => setPreview(null)} className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10">Close</button>
                    </div>
                    <pre className="overflow-auto whitespace-pre-wrap p-5 text-sm leading-6 text-gray-200">{preview.content}</pre>
                </div>
            </div>}
        </div>
    )
}
