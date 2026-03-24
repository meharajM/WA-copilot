/**
 * ChatView.tsx — Slim orchestrator for the main chat area.
 *
 * Composes:
 *   - EmptyState — welcome screen + workflow tiles
 *   - MessageBubble — individual message rendering (itself decomposed)
 *   - TypingIndicator — bouncing dots during processing
 *   - ProgressBanner — task progress bar + plan
 *   - JumpToBottom — scroll-to-bottom overlay
 *
 * Store subscriptions and auto-scroll hook remain here.
 */

import React from 'react'
import { Trash2, CheckCircle } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { JumpToBottom } from '../JumpToBottom'

import { MessageBubble } from './MessageBubble'
import { EmptyState } from './EmptyState'
import { TypingIndicator } from './TypingIndicator'
import { ProgressBanner } from './ProgressBanner'

interface ChatViewProps {
  onClearChat?: () => void
}

export function ChatView({ onClearChat }: ChatViewProps) {
  const {
    sessions,
    activeSessionId,
    removeMessage,
    clearMessages,
    updateSessionStatus,
  } = useChatStore()

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const messages = activeSession?.messages || []
  

  const isProcessing = useChatStore(s => 
    activeSessionId ? s._processingSessions.has(activeSessionId) : false
  )

  const {
    scrollContainerRef,
    messagesEndRef,
    handleScroll,
    isAtBottom,
    hasUnread,
    scrollToBottom,
  } = useAutoScroll(messages, isProcessing)

  const handleClear = () => {
    if (window.confirm('Clear all messages? This cannot be undone.')) {
      clearMessages()
      onClearChat?.()
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Header with clear button */}
      {messages.length > 0 && activeSession && (
        <div className="flex justify-between items-center px-4 py-2 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            {activeSession.status === 'resolved' ? (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/20 text-[#25D366] text-[10px] font-bold uppercase tracking-wider">
                <CheckCircle size={10} />
                Resolved
              </span>
            ) : (
                <button
                    onClick={() => activeSessionId && updateSessionStatus(activeSessionId, 'resolved')}
                    className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[#25D366] px-2 py-1 rounded hover:bg-green-500/10 transition-all font-medium"
                >
                    <CheckCircle size={14} />
                    Resolve Conversation
                </button>
            )}
          </div>
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10 transition-all"
          >
            <Trash2 size={14} />
            Clear Chat
          </button>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-4 min-w-0"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              onDelete={removeMessage}
              isLast={index === messages.length - 1}
            />
          ))
        )}

        {/* Typing indicator */}
        {isProcessing &&
          !messages[messages.length - 1]?.content.includes(
            'Parallel Execution'
          ) && <TypingIndicator />}

        {/* Progress banner */}
        {activeSession && (
          <ProgressBanner session={activeSession} />
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Jump to bottom overlay */}
      <JumpToBottom
        isAtBottom={isAtBottom}
        hasUnread={hasUnread}
        onScrollToBottom={scrollToBottom}
      />
    </div>
  )
}
