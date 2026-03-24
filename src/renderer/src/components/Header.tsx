import React from 'react'
import { Wifi, WifiOff, MessageCircle, LayoutDashboard, MessageSquare } from 'lucide-react'
import { useWhatsAppStore } from '../stores/whatsappStore'
import { StatusDot } from './primitives/StatusDot'
import { View } from './Sidebar'

interface HeaderProps {
    status: { provider: string | null; available: boolean }
    currentView: View
    onViewChange: (view: View) => void
}

export function Header({ status, currentView, onViewChange }: HeaderProps) {
    const { connectionState, whatsappEnabled, openDialog } = useWhatsAppStore()
    const isWhatsAppConnected = connectionState.status === 'connected'
    
    return (
        <header className="h-[var(--space-12)] flex items-center justify-between px-[var(--space-4)] border-b border-[var(--color-border)] flex-shrink-0 bg-[var(--color-bg-dark)] shadow-sm z-20">
            <div className="flex items-center gap-1">
                <button 
                    onClick={() => onViewChange('dashboard')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        currentView === 'dashboard' 
                        ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]' 
                        : 'text-[var(--color-text-dim)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]'
                    }`}
                >
                    <LayoutDashboard size={14} />
                    <span>Dashboard</span>
                </button>
                <button 
                    onClick={() => onViewChange('chat')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        currentView === 'chat' 
                        ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]' 
                        : 'text-[var(--color-text-dim)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]'
                    }`}
                >
                    <MessageSquare size={14} />
                    <span>Conversations</span>
                </button>
            </div>

            <div className="text-[10px] uppercase tracking-widest text-[var(--color-text-dim)] hidden sm:flex items-center gap-2">
                <StatusDot variant="success" size="sm" animated />
                business-bot: active

                {/* WhatsApp status indicator */}
                {isWhatsAppConnected && (
                    <button
                        id="header-whatsapp-status"
                        onClick={openDialog}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#25D366]/15 hover:bg-[#25D366]/25 transition-colors cursor-pointer"
                        title="WhatsApp connected — click to manage"
                    >
                        <MessageCircle size={10} className="text-[#25D366]" />
                        <span className="text-[#25D366] text-[9px] font-bold tracking-widest">
                            {whatsappEnabled ? 'WHATSAPP ON' : 'WHATSAPP'}
                        </span>
                        <span className="w-1 h-1 rounded-full bg-[#25D366] animate-pulse" />
                    </button>
                )}
            </div>

            {/* LLM Status */}
            <div className={`flex items-center gap-1.5 text-[10px] font-[var(--font-weight-medium)] ${status.available ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'
                }`}>
                {status.available ? <Wifi size={12} /> : <WifiOff size={12} />}
                <span className="uppercase tracking-wide">
                    {status.provider || 'No LLM'}
                </span>
            </div>
        </header>
    )
}
