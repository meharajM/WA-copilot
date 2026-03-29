import React, { useMemo, useState, useCallback } from 'react'
import { useWhatsAppStore } from '../../stores/whatsappStore'
import { useChatStore } from '../../stores/chatStore'
import { executeToolCall } from '../../lib/mcp'
import electron from '../../lib/electron'
import { MessageSquare, ShieldCheck, CheckCircle2, FileUp, Bot, MessageCircle, Loader2, UploadCloud, PieChart, FileText, RefreshCw } from 'lucide-react'
import { StatusBadge } from '../primitives/StatusDot'
import { clsx } from 'clsx'
import { KnowledgeTest } from './KnowledgeTest'
import { ViewMode } from '../Sidebar'


/**
 * Co-Worker Hub Welcome Screen -> Business Bot Dashboard
 */
export function EmptyState({ onNavigate }: { onNavigate?: (view: ViewMode) => void }) {
  const { connectionState, openDialog, whatsappEnabled, setWhatsAppEnabled } = useWhatsAppStore()
  const { sessions, updateSessionTopic } = useChatStore()
  const isConnected = connectionState.status === 'connected'
  const isConnecting = connectionState.status === 'connecting'

  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'done'>('idle')
  const [analyzing, setAnalyzing] = useState(false)
  const [ragStats, setRagStats] = useState<{ count: number; fileTypes: Record<string, number>; totalSize: number }>({ count: 0, fileTypes: {}, totalSize: 0 })
  const [memoryStats, setMemoryStats] = useState<{ entityCount: number; relationCount: number }>({ entityCount: 0, relationCount: 0 })
  const [intelligenceStats, setIntelligenceStats] = useState<{ totalQueries: number; resolvedQueries: number; autonomyRate: number; trainingCount: number; learningCount: number }>({ totalQueries: 0, resolvedQueries: 0, autonomyRate: 100, trainingCount: 0, learningCount: 0 })
  interface EvolutionLog { id: number; type: string; event: string; details?: string; timestamp?: string }
  const [evolutionLogs, setEvolutionLogs] = useState<EvolutionLog[]>([])

  // Load real Intelligence stats on mount
  React.useEffect(() => {
    const fetchStats = async () => {
        try {
            // 1. Fetch RAG Stats
            const ragRes = await executeToolCall('rag_get_stats', {})
            if (ragRes.result) {
                try {
                    // MCP format check
                    const resultObj = ragRes.result as { content?: { text: string }[] }
                    if (resultObj.content?.[0]?.text) {
                        setRagStats(JSON.parse(resultObj.content[0].text))
                    } else if (typeof ragRes.result === 'object' && !('result' in (ragRes.result as any))) {
                        // Direct object (non-envelope)
                        setRagStats(ragRes.result as any)
                    } else if (typeof ragRes.result === 'object' && 'result' in (ragRes.result as any)) {
                        // Nested result (happens with some IPC bridge versions)
                        const innerResult = (ragRes.result as any).result
                        if (typeof innerResult === 'object') {
                            setRagStats(innerResult)
                        }
                    }
                } catch (err) {
                    console.error('[EmptyState] Failed to parse RAG stats:', err)
                }
            }

            // 2. Fetch Memory Stats
            const memoryRes = await electron.memory.getStats()
            if (memoryRes.success && memoryRes.stats) {
                setMemoryStats(memoryRes.stats)
            }

            // 3. Fetch Intelligence Stats & Logs
            const intelRes = await electron.intelligence.getStats()
            if (intelRes.success && intelRes.stats) {
                setIntelligenceStats(intelRes.stats)
            }

            const logsRes = await electron.intelligence.getLogs(5)
            if (logsRes.success && logsRes.logs) {
                setEvolutionLogs(logsRes.logs)
            }
        } catch (err) {
            console.error("Failed to fetch analytics:", err)
        }
    }
    fetchStats()
    const interval = setInterval(fetchStats, 10000) // Polling for live-ish updates
    return () => clearInterval(interval)
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
        knowledgeDocs: ragStats.count,
        memoryFacts: memoryStats.entityCount,
        dataPoints: ragStats.count + memoryStats.entityCount,
        autonomyRate: intelligenceStats.autonomyRate.toFixed(1)
    }
  }, [sessions, ragStats, memoryStats, intelligenceStats])

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
          const files = Array.from(e.target.files) as (File & { path?: string })[]
          let successCount = 0

          for (const file of files) {
              if (file.path) {
                  // The rag_ingest tool will use markitdown to convert and embed the file into LanceDB/SQLite
                  const res = await executeToolCall('rag_ingest', { filePath: file.path })
                  if (res.error) {
                    console.error(`Failed to ingest ${file.name}:`, res.error)
                  } else {
                    successCount++
                    
                    // ── STEP: LINKED EVOLUTION ──
                    // After Training (RAG), start Learning (Memory extraction)
                    const resData = res.result as { content?: string }
                    if (resData?.content) {
                        import('../../lib/memory-reflector').then(({ MemoryReflector }) => {
                            MemoryReflector.getInstance().analyzeDocument(
                                resData.content!, 
                                file.name, 
                                {} // Default settings or fetch from store
                            )
                        })
                    }
                  }
              } else {
                  console.warn(`File path not available for ${file.name}. This feature requires the Electron desktop app.`)
              }
          }

          if (successCount > 0) {
              setUploadStatus('done')
              // Update stats immediately
              const statsRes = await executeToolCall('rag_get_stats', {})
              if (statsRes.result) {
                  try {
                      // MCP format check
                      const resObj = statsRes.result as { count: number; fileTypes: Record<string, number>; totalSize: number } | { content?: { text: string }[] }
                      if ('content' in resObj && resObj.content?.[0]?.text) {
                          setRagStats(JSON.parse(resObj.content[0].text))
                      } else if ('count' in resObj) {
                          setRagStats(resObj)
                      }
                  } catch (err) {
                      console.error('[EmptyState] Failed to parse stats after upload:', err)
                  }
              }
              setTimeout(() => setUploadStatus('idle'), 5000)
          } else {
              alert(`None of the selected files could be processed. Please ensure 'uv' is installed for document conversion.`)
              setUploadStatus('idle')
          }
      } catch (err) {
          console.error("RAG Ingest Error:", err)
          setUploadStatus('idle')
      }
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
            WA Co-Pilot Dashboard
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
          <div className="grid grid-cols-4 gap-4 w-full">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Daily Msgs</p>
                <p className="text-2xl font-bold text-[var(--color-brand-teal)]">{metrics.messagesToday}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Active Leads</p>
                <p className="text-2xl font-bold text-[#25D366]">{metrics.activeLeads}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Data Points</p>
                <p className="text-2xl font-bold text-blue-400">{metrics.dataPoints}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm">
                <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-2">Autonomy</p>
                <p className="text-2xl font-bold text-purple-400">{metrics.autonomyRate}%</p>
            </div>
          </div>

          {/* Customer Insights Analytics */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-sm mb-6">
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

          {/* Intelligence & Knowledge Analytics */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-sm">
             <div className="flex items-center gap-2 mb-6">
                <CheckCircle2 size={20} className="text-green-400" />
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Intelligence Assets</h3>
             </div>

             <div className="grid grid-cols-2 gap-6">
                {/* RAG Breakdown */}
                <div className="flex flex-col gap-4">
                   <p className="text-sm font-semibold text-[var(--color-text-muted)] border-b border-[var(--color-border)] pb-2 uppercase tracking-tight">Knowledge Map</p>
                   {Object.entries(ragStats.fileTypes).length > 0 ? (
                      Object.entries(ragStats.fileTypes).map(([type, count]) => (
                        <div key={type} className="flex items-center justify-between text-sm">
                           <span className="text-[var(--color-text-secondary)] uppercase">{type} Files</span>
                           <span className="text-[var(--color-text-primary)] font-bold">{count}</span>
                        </div>
                      ))
                   ) : (
                      <p className="text-xs text-[var(--color-text-muted)] italic">No data indexed yet</p>
                   )}
                   <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
                      <p className="text-xs text-[var(--color-text-muted)]">Total Size: <span className="text-[var(--color-text-primary)]">{(ragStats.totalSize / 1024).toFixed(1)} KB</span></p>
                   </div>
                </div>

                {/* Memory Breakdown */}
                <div className="flex flex-col gap-4">
                   <p className="text-sm font-semibold text-[var(--color-text-muted)] border-b border-[var(--color-border)] pb-2 uppercase tracking-tight">Long-Term Memory</p>
                   <div className="flex items-center justify-between text-sm">
                      <span className="text-[var(--color-text-secondary)]">Learned Facts</span>
                      <span className="text-[var(--color-text-primary)] font-bold">{memoryStats.entityCount}</span>
                   </div>
                   <div className="flex items-center justify-between text-sm">
                      <span className="text-[var(--color-text-secondary)]">Relationships</span>
                      <span className="text-[var(--color-text-primary)] font-bold">{memoryStats.relationCount}</span>
                   </div>
                   <div className="mt-2 p-3 bg-blue-500/10 rounded-lg">
                      <p className="text-[10px] leading-tight text-blue-400">
                         Facts are automatically extracted from conversations to improve future accuracy.
                      </p>
                   </div>
                </div>
             </div>
          </div>

          {/* Self-Learning & Evolution Activity */}
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 shadow-sm mt-6 mb-8">
             <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                   <RefreshCw size={20} className="text-purple-400" />
                   <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Agent Evolution Log</h3>
                </div>
                <StatusBadge variant="success" label="Learning Active" animated />
             </div>

             <div className="flex flex-col gap-3">
                {evolutionLogs.length > 0 ? (
                  evolutionLogs.map((log) => (
                    <div key={log.id} className="flex gap-4 p-3 rounded-lg bg-white/5 border border-[var(--color-border)] hover:bg-white/10 transition-colors">
                      <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                        log.type === 'training' ? 'bg-blue-400' : 
                        log.type === 'learning' ? 'bg-purple-400' : 
                        log.event === 'resolved' ? 'bg-green-400' : 'bg-red-400'
                      }`} />
                      <div className="flex flex-col gap-0.5 overflow-hidden">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase font-bold tracking-tight text-[var(--color-text-muted)]">{log.type}</span>
                          <span className="text-[10px] text-[var(--color-text-muted)]">•</span>
                          <span className="text-[10px] opacity-50 block mt-1">{new Date(log.timestamp || Date.now()).toLocaleTimeString()}</span>
                        </div>
                        <p className="text-xs font-semibold text-[var(--color-text-primary)] leading-tight">{log.event.replace('_', ' ')}</p>
                        <p className="text-[11px] text-[var(--color-text-secondary)] truncate">{log.details}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-8 flex flex-col items-center justify-center text-center opacity-50">
                    <Loader2 size={24} className="animate-spin mb-2" />
                    <p className="text-xs text-[var(--color-text-muted)]">Awaiting first data points for evolution...</p>
                  </div>
                )}
             </div>

             <div className="mt-6 pt-4 border-t border-[var(--color-border)]">
                <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  The agent evolves by extracting entities from documents (Training) and identifying behavioral patterns from your replies (Learning).
                </p>
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
              
              {/* Readiness Checklist */}
              <div className="grid grid-cols-1 gap-2 mb-6">
                {[
                    { id: 'wa', label: 'Connect WhatsApp', completed: isConnected, icon: <MessageSquare className="w-3 h-3" /> },
                    { id: 'train', label: 'Upload Training Data', completed: ragStats.count > 0, icon: <FileUp className="w-3 h-3" /> },
                    { id: 'persona', label: 'Configure Bot Identity', completed: true, icon: <ShieldCheck className="w-3 h-3" />, action: () => onNavigate?.('settings') },
                    { id: 'locked', label: 'Lock Agent Role', completed: true, icon: <Bot className="w-3 h-3" /> }
                ].map((step) => (
                    <div 
                      key={step.id} 
                      onClick={step.action}
                      className={clsx(
                        "flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider p-2 rounded-lg border transition-colors", 
                        step.completed ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-white/5 border-white/10 text-gray-400",
                        step.action && "cursor-pointer hover:bg-green-500/20 active:scale-[0.99]"
                      )}
                    >
                        {step.icon}
                        <span>{step.label}</span>
                        {step.completed && !step.action && <CheckCircle2 className="w-3 h-3 ml-auto" />}
                        {step.action && <span className="ml-auto text-[9px] bg-green-500/20 px-2 py-0.5 rounded text-green-400 hover:text-green-300">Edit Settings</span>}
                    </div>
                ))}
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

              {/* Show Knowledge Test after successful upload */}
              {ragStats.count > 0 && <KnowledgeTest />}
           </div>

        </div>
      </div>
    </div>
  )
}
