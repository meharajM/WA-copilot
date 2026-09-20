import React from 'react'
import { RotateCcw, Brain, Check, X } from 'lucide-react'
import { CopyButton } from '../primitives/CopyButton'
import { IconButton } from '../primitives/IconButton'
import { useChatStore } from '../../stores/chatStore'
import { executeToolCall } from '../../lib/mcp'

interface MessageAction {
  type: string
  label: string
  payload?: Record<string, unknown>
}

interface MessageActionsProps {
  /** Message ID (for regenerate) */
  messageId: string
  /** Message content (for copy) */
  content: string
  /** Action buttons from the message (continue/stop) */
  actions?: MessageAction[]
}

/**
 * Footer action bar for assistant messages: copy, regenerate, and custom actions.
 * Extracted from MessageBubble for independent experiment control.
 */
export function MessageActions({ messageId, content, actions }: MessageActionsProps) {
  const [isCorrecting, setIsCorrecting] = React.useState(false)
  const [correction, setCorrection] = React.useState('')
  const [isSaved, setIsSaved] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)

  const handleSaveToBrain = async () => {
    if (!correction.trim()) return
    setIsSaving(true)
    try {
      // Find the user's question before this assistant message
      const session = useChatStore.getState().sessions.find(s => s.id === useChatStore.getState().activeSessionId);
      const msgIndex = session?.messages.findIndex(m => m.id === messageId) ?? -1;
      const userQuestion = msgIndex > 0 ? session?.messages[msgIndex - 1].content : 'General Inquiry';

      // Route through the runtime-aware executor so browser product uses agentd
      // and Electron keeps its legacy internal-rag path.
      const result = await executeToolCall('rag_save_correction', {
          question: userQuestion,
          answer: correction
      })
      if (result.error) throw new Error(result.error)

      setIsSaved(true)
      setTimeout(() => setIsCorrecting(false), 2000)
    } catch (error) {
      console.error('Failed to save correction:', error)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      {/* Custom action buttons (continue, stop) */}
       {actions && actions.length > 0 && (
         <div className="mt-4 flex flex-wrap gap-2">
           {actions.map((action, idx) => {
             // Handle custom "open drafts" action
             if (action.type === 'custom' && action.payload?.action === 'open_drafts') {
               return (
                 <button
                   key={`${action.type}-${idx}`}
                   onClick={() => {
                     window.dispatchEvent(new CustomEvent('app:open-drafts'))
                   }}
                   className={`px-4 py-2 rounded-lg text-sm font-medium transition-all bg-[var(--color-success)] hover:bg-[var(--color-success)]/80 text-[var(--color-text-inverse)]`}
                 >
                   {action.label}
                 </button>
               );
             }
             
             return (
               <button
                 key={`${action.type}-${idx}`}
                 onClick={() => {
                   const eventContent =
                     action.type === 'continue' ? 'continue' : action.type === 'stop' ? 'stop' : 'approve';
                   window.dispatchEvent(
                     new CustomEvent('agent-action', {
                       detail: { type: action.type, content: eventContent },
                     })
                   )
                 }}
                 className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                   action.type === 'continue'
                     ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent)]/80 text-[var(--color-text-inverse)]'
                     : action.type === 'stop'
                       ? 'bg-[var(--color-surface-hover)] hover:bg-[var(--color-border)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
                       : 'bg-[var(--color-surface-hover)] hover:bg-[var(--color-border)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
                 }`}
               >
                 {action.label}
               </button>
             );
           })}
         </div>
       )}

      {/* Hover action bar (copy + regenerate) */}
      <div className="flex items-center gap-2 mt-1 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton content={content} />
        <IconButton
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('agent-action', {
                detail: { type: 'regenerate', messageId },
              })
            )
          }
          icon={<RotateCcw size={16} />}
          title="Regenerate"
        />
        <IconButton
          onClick={() => setIsCorrecting(!isCorrecting)}
          icon={<Brain size={16} color={isSaved ? 'var(--color-success)' : undefined} />}
          title="Correct and Teach"
        />
      </div>

      {/* Feedback / Learning UI */}
      {isCorrecting && (
        <div className="mt-3 p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)] flex items-center gap-1.5">
              <Brain size={12} />
              Correct this answer to teach the brain
            </span>
            <button onClick={() => setIsCorrecting(false)} className="text-[var(--color-text-dim)] hover:text-[var(--color-text-primary)]">
              <X size={14} />
            </button>
          </div>
          
          <textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="What should the correct answer be?"
            className="w-full h-24 bg-[var(--color-surface-dark)] border border-[var(--color-border)] rounded-lg p-2.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] resize-none"
            autoFocus
          />
          
          <div className="flex justify-end mt-2">
            <button
              onClick={handleSaveToBrain}
              disabled={!correction.trim() || isSaving || isSaved}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                isSaved 
                  ? 'bg-[var(--color-success)] text-white' 
                  : 'bg-[var(--color-primary)] text-[var(--color-text-inverse)] hover:bg-[var(--color-primary)]/90 disabled:opacity-50'
              }`}
            >
              {isSaving ? (
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : isSaved ? (
                <Check size={14} />
              ) : (
                <Brain size={14} />
              )}
              {isSaved ? 'Learned!' : 'Save to Brain'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
