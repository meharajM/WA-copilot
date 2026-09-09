import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import electron from '../lib/electron'
import type { ChatSession } from '../stores/chatStore'

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const RESOLUTION_PROMPT = "It's been a while! Just checking in—did that resolve your inquiry? (Reply 'Yes' or 'No', or feel free to ask more questions!)"

export type ResolutionAuditAction =
  | {
      type: 'send_followup'
      sessionId: string
      whatsappJid: string
      prompt: string
    }
  | {
      type: 'log_user_silence'
      sessionId: string
    }

/**
 * Pure decision helper used by the hook and tests.
 * Determines which sessions need follow-up actions based on inactivity windows.
 */
export function computeResolutionAuditActions(
  sessions: ChatSession[],
  now = Date.now(),
  inactivityTimeoutMs = INACTIVITY_TIMEOUT_MS
): ResolutionAuditAction[] {
  const actions: ResolutionAuditAction[] = []

  for (const session of sessions) {
    if (session.status !== 'active' || !session.whatsapp_jid) continue

    const silenceDuration = now - session.updatedAt
    if (silenceDuration < inactivityTimeoutMs) continue

    const lastMsg = session.messages[session.messages.length - 1]
    if (!lastMsg) continue

    if (lastMsg.role === 'assistant') {
      // Don't repeat the resolution prompt if it was already sent.
      if (lastMsg.content === RESOLUTION_PROMPT) continue

      actions.push({
        type: 'send_followup',
        sessionId: session.id,
        whatsappJid: session.whatsapp_jid,
        prompt: RESOLUTION_PROMPT,
      })
    } else if (lastMsg.role === 'user') {
      actions.push({
        type: 'log_user_silence',
        sessionId: session.id,
      })
    }
  }
  return actions
}

export function shouldUseLegacyResolutionAudit(autonomyState: { status?: string } | null | undefined): boolean {
    return autonomyState?.status !== 'running' && autonomyState?.status !== 'degraded'
}

/**
 * Intelligent Resolution Auditor Hook
 * 
 * Monitors active WhatsApp-linked sessions for inactivity.
 * After 10 minutes of silence, it triggers a resolution inquiry.
 */
export function useResolutionAudit() {
    const { sessions, addSessionMessage, updateSessionActivity } = useChatStore()
    const timerRef = useRef<NodeJS.Timeout | null>(null)

    useEffect(() => {
        // Clear any existing global timer
        if (timerRef.current) clearInterval(timerRef.current)

        // Run audit every minute
        timerRef.current = setInterval(async () => {
            const autonomyState = await electron.autonomy.getState().catch(() => null)
            if (!shouldUseLegacyResolutionAudit(autonomyState)) return
            const actions = computeResolutionAuditActions(sessions)

            actions.forEach((action) => {
                if (action.type === 'send_followup') {
                    addSessionMessage(action.sessionId, {
                        role: 'assistant',
                        content: action.prompt,
                        thought: '[Resolution Audit] 15min inactivity detected. Prompting for closure.',
                    })

                    electron.whatsapp
                        .sendMessage(action.whatsappJid, action.prompt)
                        .catch((err) => {
                            console.error(
                                `[ResolutionAudit] Failed to send follow-up for ${action.sessionId}:`,
                                err
                            )
                        })

                    // Bump activity to prevent repeated prompts every minute.
                    updateSessionActivity(action.sessionId)
                } else {
                    console.log(`[ResolutionAudit] Long user silence for ${action.sessionId}`)
                }
            })
        }, 60000)

        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [sessions, addSessionMessage, updateSessionActivity])
}
