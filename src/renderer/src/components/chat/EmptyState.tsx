import React, { useMemo, useState, useCallback } from 'react'
import { useWhatsAppStore } from '../../stores/whatsappStore'
import { useChatStore } from '../../stores/chatStore'
import { executeToolCall } from '../../lib/mcp'
import { MessageCircle, Loader2, UploadCloud, PieChart, FileText, CheckCircle2, RefreshCw } from 'lucide-react'
import { StatusBadge } from '../primitives/StatusDot'

/**
 * Co-Worker Hub Welcome Screen -> Business Bot Dashboard
 */
export function EmptyState() {
  const { connectionState, openDialog, whatsappEnabled, setWhatsAppEnabled } = useWhatsAppStore()
  const { sessions, updateSessionTopic } = useChatStore()
  const isConnected = connectionState.status === 'connected'
  const isConnecting = connectionState.status === 'connecting'

  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'done'>('idle')
  const [analyzing, setAnalyzing] = useState(false)
  const [ragCount, setRagCount] = useState(0)

  // Load real RAG document count on mount
  React.useEffect(() => {
    const fetchRagCount = async () => {
        try {
            const res = await executeToolCall('rag_get_count', {})
            if (res.result) {
                // MCP tools return { result: { content: [{text: "..."}] } } if wrapped or just raw if simple
                const resultObj = res.result as { content?: { text: string }[] }
                const countStr = resultObj.content?.[0]?.text ?? String(res.result)
                setRagCount(parseInt(countStr) || 0)
            }
        } catch (err) {
            console.error("Failed to fetch RAG count:", err)
        }
    }
    fetchRagCount()
  }, [])

  // Calculate real metrics
  const metrics = useMemo(() => {
    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000
    
    let messagesToday = 0
    const uniqueJids = new Set<string>()

    sessions.forEach(session => {
        if (session.updatedAt > oneDayAgo) {
            messagesToday += session.messages.filter(m => m.role !== 'system').length
        }
        if (session.whatsapp_jid) {
            uniqueJids.add(session.whatsapp_jid)
        }
    })

    return {
        messagesToday,
        activeLeads: uniqueJids.size,
        knowledgeDocs: ragCount
    }
  }, [sessions, ragCount])

  // Aggregate Analytics based on successfully analyzed session topics
  const insights = useMemo(() => {
    const topicsLog = sessions.map(s => s.topic).filter(Boolean) as string[]
    
    // If no sessions have been analyzed yet, show the mock/default
    if (topicsLog.length === 0) {
      const total = Math.max(metrics.messagesToday, 10) // default to 10 for visual mock if empty
      return [
        { name: 'Product Queries', percent: Math.round((total * 0.45) / total * 100) },
        { name: 'Order Status', percent: Math.round((total * 0.35) / total * 100) },
        { name: 'Returns/Refunds', percent: Math.round((total * 0.20) / total * 100) },
      ]
    }

    const counts: Record<string, number> = {}
    topicsLog.forEach(t => counts[t] = (counts[t] || 0) + 1)
    
    const total = topicsLog.length
    return Object.entries(counts)
      .map(([name, count]) => ({ name, percent: Math.round((count / total) * 100) }))
      .sort((a,b) => b.percent - a.percent)
      .slice(0, 3) 
  }, [sessions, metrics.messagesToday])

  // Triggers background LLM analysis of un-categorized sessions
  const analyzeTopics = useCallback(async () => {
    if (analyzing) return
    setAnalyzing(true)
    try {
      // Lazy load LLM to avoid heavy imports until clicked
      const { chat } = await import('../../lib/llm')
      
      // Find up to 5 un-analyzed completed sessions
      const unanalyzed = sessions.filter(s => (s.messages.length > 2 || s.status === 'resolved') && !s.topic).slice(0, 5)
      
      for (const session of unanalyzed) {
        if (session.messages.length === 0) continue
        const conversationText = session.messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
        
        const response = await chat([
            { role: 'user', content: `Analyze the following customer support conversation and categorize it into exactly ONE of these short topics: "Product Queries", "Order Status", "Returns/Refunds", "Technical Support", or "Other". Reply with ONLY the exact topic name, nothing else.\n\nConversation:\n${conversationText}` }
        ], [], undefined, undefined, undefined, undefined, true) // subAgent mode

        let parsedTopic = response.content.trim()
        // Basic cleanup just in case the LLM was chatty
        if (parsedTopic.includes('Product')) parsedTopic = 'Product Queries'
        else if (parsedTopic.includes('Order')) parsedTopic = 'Order Status'
        else if (parsedTopic.includes('Return') || parsedTopic.includes('Refund')) parsedTopic = 'Returns/Refunds'
        else if (parsedTopic.includes('Tech')) parsedTopic = 'Technical Support'
        else parsedTopic = 'Other'

        updateSessionTopic(session.id, parsedTopic)
      }
    } catch (err) {
      console.error("Topic Analysis Error:", err)
    } finally {
      setAnalyzing(false)
    }
  }, [analyzing, sessions, updateSessionTopic])

  const handleWhatsAppClick = () => {
    if (isConnecting) return
    if (isConnected) {
      setWhatsAppEnabled(!whatsappEnabled)
    } else {
      openDialog()
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setUploadStatus('uploading')
      
      try {
          // In Electron, File objects contain the absolute path on the user's filesystem
          const file = e.target.files[0] as File & { path?: string }
          if (file.path) {
              // The rag_ingest tool will use markitdown to convert and embed the file into LanceDB/SQLite
              const res = await executeToolCall('rag_ingest', { filePath: file.path })
              if (res.error) {
                console.error("Failed to ingest file:", res.error)
                // Just fallback to visual error state or revert
              } else {
                setUploadStatus('done')
                // Update doc count immediately
                const countRes = await executeToolCall('rag_get_count', {})
                if (countRes.result) {
                    const resultObj = countRes.result as { content?: { text: string }[] }
                    const countStr = resultObj.content?.[0]?.text ?? String(countRes.result)
                    setRagCount(parseInt(countStr) || 0)
                }
              }
          }
      } catch (err) {
          console.error("RAG Ingest Error:", err)
      }

      setTimeout(() => setUploadStatus('idle'), 3000)
    }
  }

  // Auto-analyze resolved sessions on mount or when sessions update
  React.useEffect(() => {
    const unanalyzedResolved = sessions.filter(s => s.status === 'resolved' && !s.topic && s.messages.length > 0)
    if (unanalyzedResolved.length > 0 && !analyzing) {
        // We use a slight delay to ensure the UI feels responsive
        const timer = setTimeout(() => analyzeTopics(), 2000)
        return () => clearTimeout(timer)
    }
    return () => {}
  }, [sessions, analyzing, analyzeTopics])

  // Fix stale state
  React.useEffect(() => {
    if (!isConnected && whatsappEnabled) {
      setWhatsAppEnabled(false)
    }
  }, [isConnected, whatsappEnabled, setWhatsAppEnabled])

  return (
    <div className="flex flex-col items-center justify-start h-full max-w-5xl mx-auto w-full pt-8 pb-12 overflow-y-auto hide-scrollbar">

      {/* Header Section */}
      <div className="mb-6 w-full flex items-center justify-between px-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">
            Business Dashboard
          </h1>
          <h2 className="text-sm font-medium text-[var(--color-text-secondary)] mt-1">
            {isConnected ? "Bot is online and monitoring customer queues" : "Connect your WhatsApp to activate the agent"}
          </h2>
        </div>
        <StatusBadge variant={isConnected ? "success" : "warning"} label={isConnected ? "System Active" : "Offline"} animated={isConnected} />
      </div>

      {/* Layout Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full px-4">
        
        {/* Left Column: Metrics & WhatsApp Config */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          
          {/* Top KPI Cards */}
          <div className="grid grid-cols-3 gap-4 w-full">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Daily Messages</p>
                <p className="text-3xl font-bold text-[var(--color-brand-teal)]">{metrics.messagesToday}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Active Leads</p>
                <p className="text-3xl font-bold text-[#25D366]">{metrics.activeLeads}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Indexed Docs</p>
                <p className="text-3xl font-bold text-blue-400">{metrics.knowledgeDocs}</p>
            </div>
          </div>

          {/* Customer Insights Analytics */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <PieChart size={20} className="text-[var(--color-brand-teal)]" />
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Conversation Topics</h3>
              </div>
              <button 
                onClick={analyzeTopics}
                disabled={analyzing}
                title="Use AI to analyze un-categorized recent sessions"
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-brand-teal)] transition-colors disabled:opacity-50 disabled:cursor-wait"
              >
                <RefreshCw size={14} className={analyzing ? "animate-spin" : ""} />
                {analyzing ? "Analyzing..." : "Sync Insights"}
              </button>
            </div>
            
            <div className="flex flex-col gap-4">
              {insights.map((item, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--color-text-secondary)] font-medium">{item.name}</span>
                    <span className="text-[var(--color-text-primary)] font-bold">{item.percent}%</span>
                  </div>
                  <div className="w-full bg-[var(--color-border)] rounded-full h-2.5">
                    <div 
                      className={`h-2.5 rounded-full ${i === 0 ? 'bg-[var(--color-brand-teal)]' : i === 1 ? 'bg-blue-500' : 'bg-purple-500'}`}
                      style={{ width: `${item.percent}%` }}
                    ></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* Right Column: Actions & Upload */}
        <div className="lg:col-span-4 flex flex-col gap-6">
           
           {/* WhatsApp Connection CTA */}
           <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-sm">
              <div className="flex flex-col items-center justify-center text-center">
                <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${isConnected ? 'bg-[#25D366]/20' : 'bg-white/5'}`}>
                  <MessageCircle size={32} className={isConnected ? 'text-[#25D366]' : 'text-white/30'} />
                </div>
                <h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-2">WhatsApp Agent</h3>
                <p className="text-sm text-[var(--color-text-secondary)] border-b border-[var(--color-border)] pb-6 mb-6">
                  {isConnected ? "The bot is fully autonomous and handling queries." : "Link your WhatsApp Business App to start automating."}
                </p>

                <button
                    onClick={handleWhatsAppClick}
                    disabled={isConnecting}
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border transition-all font-semibold
                      ${isConnecting ? 'opacity-50 cursor-wait' : ''}
                      ${isConnected
                        ? 'bg-[#25D366] text-black border-[#25D366] hover:bg-[#25D366]/90'
                        : 'bg-white text-black border-white hover:bg-gray-200'
                      }
                    `}
                >
                  {isConnecting ? <Loader2 size={18} className="animate-spin" /> : null}
                  {isConnecting ? 'Connecting...' : isConnected ? (whatsappEnabled ? 'Pause Bot Agent' : 'Resume Bot Agent') : 'Connect Account'}
                </button>
              </div>
           </div>

           {/* Knowledge Base Upload */}
           <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-sm flex-1">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FileText size={20} className="text-blue-400" />
                  <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Train AI</h3>
                </div>
              </div>
              <p className="text-sm text-[var(--color-text-secondary)] mb-6">
                Upload business documents, policies, and pricing charts to teach your bot.
              </p>

              <label className={`
                flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors
                ${uploadStatus === 'idle' ? 'border-[var(--color-border)] hover:border-[var(--color-brand-teal)] hover:bg-[var(--color-brand-teal)]/5' : ''}
                ${uploadStatus === 'uploading' ? 'border-blue-500 bg-blue-500/10 cursor-wait' : ''}
                ${uploadStatus === 'done' ? 'border-green-500 bg-green-500/10' : ''}
              `}>
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    {uploadStatus === 'idle' && (
                      <>
                        <UploadCloud size={28} className="text-[var(--color-text-muted)] mb-3" />
                        <p className="text-sm text-[var(--color-text-secondary)] font-medium">Click to select files</p>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1">PDF, TXT, CSV (Max 10MB)</p>
                      </>
                    )}
                    {uploadStatus === 'uploading' && (
                      <>
                        <Loader2 size={28} className="text-blue-500 animate-spin mb-3" />
                        <p className="text-sm text-blue-400 font-medium">Processing & Embedding...</p>
                      </>
                    )}
                    {uploadStatus === 'done' && (
                      <>
                        <CheckCircle2 size={28} className="text-green-500 mb-3" />
                        <p className="text-sm text-green-400 font-medium">Knowledge Updated!</p>
                      </>
                    )}
                  </div>
                  <input type="file" className="hidden" multiple accept=".pdf,.txt,.csv,.docx" onChange={handleFileUpload} disabled={uploadStatus !== 'idle'} />
              </label>
           </div>

        </div>
      </div>
    </div>
  )
}
