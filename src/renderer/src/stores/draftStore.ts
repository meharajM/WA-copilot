/**
 * draftStore.ts — Zustand store for email draft management.
 *
 * Owns: pending drafts, approval state, audit log.
 * Drafts are created by the confidence gate and reviewed by humans
 * before being sent.
 *
 * Per zustand-stores.md: stores do not import each other, no class instances
 * are persisted, and all async callbacks read state via getState().
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { EmailDraft, EmailPolicyDecision } from '../lib/email-policy'

interface DraftState {
  /** All drafts (pending, approved, rejected, sent) */
  drafts: EmailDraft[]

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Add a new draft (from confidence gate or manual creation) */
  addDraft: (draft: EmailDraft) => void

  /** Approve a draft for sending */
  approveDraft: (draftId: string) => void

  /** Reject a draft (discard without sending) */
  rejectDraft: (draftId: string) => void

  /** Mark a draft as sent (after approval + send) */
  markDraftSent: (draftId: string) => void

  /** Update the response text of a draft (human editing) */
  updateDraftText: (draftId: string, newText: string) => void

  /** Remove a draft entirely */
  removeDraft: (draftId: string) => void

  /** Clear all drafts older than 24 hours */
  cleanupOldDrafts: () => void
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: [],

      addDraft: (draft) =>
        set((state) => ({
          drafts: [draft, ...state.drafts],
        })),

      approveDraft: (draftId) =>
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === draftId ? { ...d, status: 'approved' as const } : d
          ),
        })),

      rejectDraft: (draftId) =>
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === draftId ? { ...d, status: 'rejected' as const } : d
          ),
        })),

      markDraftSent: (draftId) =>
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === draftId ? { ...d, status: 'sent' as const } : d
          ),
        })),

      updateDraftText: (draftId, newText) =>
        set((state) => ({
          drafts: state.drafts.map((d) =>
            d.id === draftId ? { ...d, responseText: newText } : d
          ),
        })),

      removeDraft: (draftId) =>
        set((state) => ({
          drafts: state.drafts.filter((d) => d.id !== draftId),
        })),

      cleanupOldDrafts: () => {
        const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000
        set((state) => ({
          drafts: state.drafts.filter(
            (d) => d.createdAt > twentyFourHoursAgo || d.status === 'pending_review'
          ),
        }))
      },
    }),
    {
      name: 'aica-email-drafts-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist pending and approved drafts
        drafts: state.drafts.filter(
          (d) => d.status === 'pending_review' || d.status === 'approved'
        ),
      }),
    }
  )
)
