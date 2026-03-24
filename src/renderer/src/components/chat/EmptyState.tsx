import React, { useMemo } from 'react'
import { useWhatsAppStore } from '../../stores/whatsappStore'
import { useChatStore } from '../../stores/chatStore'
import { MessageCircle, Loader2 } from 'lucide-react'
import { StatusBadge } from '../primitives/StatusDot'

/**
 * Co-Worker Hub Welcome Screen
 */
export function EmptyState() {
  const { connectionState, openDialog, whatsappEnabled, setWhatsAppEnabled } = useWhatsAppStore()
  const { sessions } = useChatStore()
  const isConnected = connectionState.status === 'connected'
  const isConnecting = connectionState.status === 'connecting'

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
        knowledgeDocs: 12 // Placeholder for RAG docs
    }
  }, [sessions])

  const handleWhatsAppClick = () => {
    if (isConnecting) return // Prevent clicks while connecting

    if (isConnected) {
      setWhatsAppEnabled(!whatsappEnabled)
    } else {
      openDialog()
    }
  }

  // Fix stale state: if we're not connected but whatsappEnabled is true, reset it
  React.useEffect(() => {
    if (!isConnected && whatsappEnabled) {
      setWhatsAppEnabled(false)
    }
  }, [isConnected, whatsappEnabled, setWhatsAppEnabled])

  return (
    <div className="flex flex-col items-center justify-center min-h-full max-w-4xl mx-auto w-full pt-8 pb-32">

            {/* System Active Badge */}
            <div className="mb-8">
                <StatusBadge variant="success" label="Business Agent Running" animated />
            </div>

            {/* Greeting */}
            <div className="text-center mb-6">
                <h1 className="text-[var(--text-4xl)] md:text-[var(--text-3xl)] font-[var(--font-weight-bold)] tracking-tight text-[var(--color-text-primary)] mb-2">
                    {isConnected ? "Bot is Online" : "Bot Offline"}
                </h1>
                <h2 className="text-[var(--text-xl)] md:text-[var(--text-xl)] font-[var(--font-weight-medium)] text-[var(--color-text-secondary)]">
                    {isConnected ? "Listening for customer queries on WhatsApp" : "Please connect your WhatsApp to start"}
                </h2>
            </div>

            {isConnected && (
                <div className="grid grid-cols-3 gap-4 mb-8 w-full max-w-2xl mt-4">
                    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
                        <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-1">Messages Today</p>
                        <p className="text-2xl font-bold text-[var(--color-brand-teal)]">{metrics.messagesToday}</p>
                    </div>
                    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
                        <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-1">Active Leads</p>
                        <p className="text-2xl font-bold text-[#25D366]">{metrics.activeLeads}</p>
                    </div>
                    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
                        <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] uppercase tracking-wider font-bold mb-1">Knowledge Docs</p>
                        <p className="text-2xl font-bold text-[var(--color-text-primary)]">{metrics.knowledgeDocs}</p>
                    </div>
                </div>
            )}

            {/* WhatsApp CTA */}
            <div className="mt-4 w-full max-w-sm">
                <button
                    id="empty-state-whatsapp-btn"
                    onClick={handleWhatsAppClick}
                    disabled={isConnecting}
                    className={`
            w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all group
            ${isConnecting ? 'opacity-50 cursor-wait' : ''}
            ${isConnected
                            ? 'border-[#25D366]/40 bg-[#25D366]/5 hover:bg-[#25D366]/10'
                            : 'border-white/10 bg-white/3 hover:bg-white/5 hover:border-white/20'
                        }
          `}
                >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isConnected ? 'bg-[#25D366]/20' : 'bg-white/5'
                        }`}>
                        {isConnecting ? (
                            <Loader2 size={16} className="text-white/50 animate-spin" />
                        ) : (
                            <MessageCircle
                                size={16}
                                className={isConnected ? 'text-[#25D366]' : 'text-white/30 group-hover:text-white/50 transition-colors'}
                            />
                        )}
                    </div>
                    <div className="text-left">
                        <p className={`text-sm font-medium ${isConnected ? 'text-[#25D366]' : 'text-white/60 group-hover:text-white/80 transition-colors'
                            }`}>
                            {isConnecting
                                ? 'Connecting...'
                                : isConnected
                                    ? whatsappEnabled ? 'Bot Agent Active' : 'Enable Bot Agent'
                                    : 'Connect Business WhatsApp'}
                        </p>
                        <p className="text-xs text-white/30 mt-0.5">
                            {isConnecting
                                ? 'Please wait...'
                                : isConnected
                                    ? 'Bot is actively monitoring incoming messages'
                                    : 'Scan QR code to link business account'}
                        </p>
                    </div>
                    {isConnected && (
                        <span className="ml-auto w-2 h-2 rounded-full bg-[#25D366] animate-pulse flex-shrink-0" />
                    )}
                </button>
            </div>
        </div>
  )
}
