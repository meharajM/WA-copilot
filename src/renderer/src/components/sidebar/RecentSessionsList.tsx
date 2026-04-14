import React, { useState } from 'react'
import { MessageSquare, Edit2, Trash2, Mail, Smartphone } from 'lucide-react'
import { useChatStore, ChatSession } from '../../stores/chatStore'
import { ViewMode } from '../Sidebar'

/** Supported channel filters for the session list */
export type ChannelFilter = 'all' | 'whatsapp' | 'email'

interface RecentSessionsListProps {
  onViewChange?: (view: ViewMode) => void
}

/** Icon mapping for channel types */
const CHANNEL_ICONS: Record<string, React.ElementType> = {
  whatsapp: Smartphone,
  email: Mail,
}

/** Human-readable labels for channel types */
const CHANNEL_LABELS: Record<string, string> = {
  all: 'All Channels',
  whatsapp: 'WhatsApp',
  email: 'Email',
}

export function RecentSessionsList({ onViewChange }: RecentSessionsListProps) {
  const {
    sessions,
    activeSessionId,
    deleteSession,
    setActiveSession,
    updateSessionTitle,
    _processingSessions,
  } = useChatStore()
  
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')

  /** Filter sessions by selected channel */
  const filteredSessions = sessions.filter((s) => {
    if (channelFilter === 'all') return true
    return s.channel === channelFilter
  })

  const startEditing = (e: React.MouseEvent, session: ChatSession) => {
    e.stopPropagation()
    setEditingId(session.id)
    setEditTitle(session.title)
  }

  const saveTitle = (id: string) => {
    if (editTitle.trim()) updateSessionTitle(id, editTitle.trim())
    setEditingId(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') saveTitle(id)
    if (e.key === 'Escape') setEditingId(null)
  }

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (window.confirm('Delete this session?')) deleteSession(id)
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      {/* Header section */}
      <div className="flex items-center justify-between mb-3 font-sans">
        <h3 className="text-[10px] font-bold text-[var(--color-text-muted)] tracking-wider uppercase">
          Active Conversations
        </h3>
      </div>

      {/* Channel filter tabs */}
      <div className="flex gap-1 mb-3">
        {(['all', 'whatsapp', 'email'] as ChannelFilter[]).map((ch) => {
          const Icon = ch === 'all' ? MessageSquare : CHANNEL_ICONS[ch]
          const isActive = channelFilter === ch
          return (
            <button
              key={ch}
              onClick={() => setChannelFilter(ch)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all ${
                isActive
                  ? 'bg-[var(--color-brand-teal)]/20 text-[var(--color-brand-teal)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]'
              }`}
              title={CHANNEL_LABELS[ch]}
            >
              <Icon size={10} />
              <span className="hidden sm:inline">{CHANNEL_LABELS[ch]}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-col gap-0.5">
        {filteredSessions.map((session) => {
          const isActive = session.id === activeSessionId
          const isProcessing = _processingSessions.has(session.id)
          const ChannelIcon = session.channel ? CHANNEL_ICONS[session.channel] : MessageSquare
          return (
            <div
              key={session.id}
              onClick={() => {
                setActiveSession(session.id)
                onViewChange?.('chat')
              }}
              className={`group relative flex items-center justify-between py-2 px-2 -mx-2 rounded-lg cursor-pointer transition-all
                ${isActive 
                  ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm' 
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text-primary)]'
                }`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                {/* Channel icon with subtle color coding */}
                <div className={`flex-shrink-0 ${
                  session.channel === 'email' ? 'text-blue-400' : 
                  session.channel === 'whatsapp' ? 'text-green-400' : 
                  'opacity-70'
                }`}>
                  <ChannelIcon size={14} />
                </div>
                
                {editingId === session.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => saveTitle(session.id)}
                    onKeyDown={(e) => handleKeyDown(e, session.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 bg-[var(--color-input-bg)] text-[var(--color-text-primary)] text-xs px-2 py-1 rounded outline-none border border-[var(--color-primary)] w-full"
                  />
                ) : (
                  <span className="text-xs font-medium truncate">
                    {session.title}
                  </span>
                )}

                {/* Pulsing indicator for actively running sessions */}
                {isProcessing && (
                  <span
                    className="flex-shrink-0 w-2 h-2 rounded-full bg-[var(--color-primary)]"
                    style={{ animation: 'pulse-dot 1.4s ease-in-out infinite' }}
                    title="Processing..."
                  />
                )}
              </div>

              {editingId !== session.id && (
                <div className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${isActive ? 'opacity-100' : ''}`}>
                  <button onClick={(e) => startEditing(e, session)} className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] rounded">
                    <Edit2 size={12} />
                  </button>
                  <button onClick={(e) => handleDelete(e, session.id)} className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-error)] rounded">
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {filteredSessions.length === 0 && (
          <div className="text-center py-6 text-xs text-[var(--color-text-dim)]">
            {channelFilter === 'all' 
              ? 'No active sessions.' 
              : `No ${CHANNEL_LABELS[channelFilter]} sessions.`}
          </div>
        )}
      </div>
    </div>
  )
}
