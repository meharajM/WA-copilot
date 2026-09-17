import { useState } from 'react'
import { Search, Loader2, CheckCircle2, XCircle, Brain } from 'lucide-react'
import { executeToolCall } from '../../lib/mcp'
import electron from '../../lib/electron'
import { useSettingsStore } from '../../stores/settingsStore'
import { chat } from '../../lib/llm'
import { getBrowserAgentdClient } from '../../lib/browser-agentd-client'
import { isTauriRuntime } from '../../lib/tauri-native-bridge'

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()

export function KnowledgeTest() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [_tested, setTested] = useState(false)

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    setResult(null)
    try {
      // Direct call to internal-rag bypasses the cache and hits the newly indexed data
      const res = await executeToolCall('rag_search', { query, limit: 3 })
      if (res.result) {
        // Handle various response formats from the bridge
        const resObj = res.result as any
        let text = ''
        
        if (typeof resObj === 'string') {
            text = resObj
        } else if (resObj.content && Array.isArray(resObj.content)) {
            text = resObj.content.map((c: any) => c.text || JSON.stringify(c)).join('\n\n')
        } else if (resObj.result) {
            text = typeof resObj.result === 'string' ? resObj.result : JSON.stringify(resObj.result, null, 2)
        } else {
            text = JSON.stringify(resObj, null, 2)
        }

        // Feed the RAG chunks into the LLM to generate a human-readable answer
        const settings = useSettingsStore.getState()
        try {
            const systemPrompt = `You are an AI assistant. Answer the user's query based ONLY on the provided Knowledge Context. If the context does not contain the answer, say "I don't have enough information in the provided documents to answer that."\n\nKnowledge Context:\n${text}`
            if (isBrowserProduct()) {
                const client = getBrowserAgentdClient()
                const sessionId = `knowledge_test_${Date.now()}`
                const requestId = `query_${Date.now()}`
                let answer = ''
                try {
                    await client.createSession(sessionId, 'Knowledge test')
                    await client.appendMessage(sessionId, { id: `system_${requestId}`, role: 'system', content: systemPrompt, timestamp: Date.now() })
                    await client.generate({ sessionId, requestId, content: query }, event => {
                        if (event.type === 'assistant.delta') answer += event.delta
                    })
                } finally {
                    await client.deleteSession(sessionId).catch(() => undefined)
                }
                setResult(answer || 'No response generated.')
            } else {
                const llmRes = await chat(
                    [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: query }
                    ],
                    undefined, // no tools
                    settings as any
                )
                setResult(llmRes.content || 'No response generated.')
            }
            setTested(true)
        } catch (llmErr: any) {
            console.error('LLM generation failed:', llmErr)
            setResult(`Knowledge found, but AI model failed to generate a response: ${llmErr.message}\n\nRaw Context:\n${text.substring(0, 200)}...`)
        }
      } else if (res.error) {
          setResult(`Error: ${res.error}`)
      }
    } catch (err) {
      console.error('Test search failed:', err)
      setResult('Failed to connect to AI engine.')
    } finally {
      setLoading(false)
    }
  }

  const logAccuracy = async (isResolved: boolean) => {
    try {
        await electron.intelligence.logAccuracy({
          event: isResolved ? 'resolved' : 'failed',
          details: `Test Query: ${query}`
        })
    } catch (err) {
        console.error('Failed to log accuracy:', err)
    }
    setResult(null)
    setQuery('')
    setTested(false)
  }

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-md animate-in fade-in slide-in-from-bottom-4 duration-500 mt-6">
      <div className="flex items-center gap-2 mb-4">
        <Brain size={20} className="text-purple-400" />
        <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Knowledge Test Drive</h3>
      </div>
      
      <p className="text-xs text-[var(--color-text-secondary)] mb-4 leading-relaxed">
        Verify your agent's training. Ask a question that should be answered by the documents you just uploaded.
      </p>

      <div className="relative mb-4">
        <input 
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="e.g. What is our refund policy?"
          className="w-full bg-[var(--color-surface-dark,var(--color-surface))] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all shadow-inner"
        />
        <button 
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-30"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
        </button>
      </div>

      {result && (
        <div className="mt-4 animate-in zoom-in-95 duration-200">
           <div className="p-4 bg-white/5 border border-[var(--color-border)] rounded-lg text-xs text-[var(--color-text-secondary)] mb-4 max-h-48 overflow-y-auto whitespace-pre-wrap leading-normal font-medium shadow-inner italic">
             {result}
           </div>

           <div className="flex flex-col gap-2">
              <p className="text-[10px] uppercase font-bold text-gray-400 mb-1">Did this answer your question?</p>
              <div className="flex gap-2">
                <button 
                  onClick={() => logAccuracy(true)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-green-500/10 border border-green-500/20 text-green-400 rounded-lg text-xs font-bold hover:bg-green-500/20 transition-all"
                >
                  <CheckCircle2 size={14} /> Correct
                </button>
                <button 
                  onClick={() => logAccuracy(false)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-xs font-bold hover:bg-red-500/20 transition-all"
                >
                  <XCircle size={14} /> Incorrect
                </button>
              </div>
           </div>
        </div>
      )}
    </div>
  )
}
