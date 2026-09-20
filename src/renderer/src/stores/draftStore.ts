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
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import type { EmailDraft } from '../lib/email-policy'
import { getBrowserAgentdClient, type BrowserEmailDraft } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'

interface DraftState {
  /** All drafts (pending, approved, rejected, sent) */
  drafts: EmailDraft[]

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Add a new draft (from confidence gate or manual creation) */
  addDraft: (draft: EmailDraft) => Promise<void>

  /** Approve a draft for sending */
  approveDraft: (draftId: string) => void

  /** Reject a draft (discard without sending) */
  rejectDraft: (draftId: string) => void

  /** Mark a draft as sent (after approval + send) */
  markDraftSent: (draftId: string) => void

  /** Mark a draft as failed after a daemon delivery attempt */
  markDraftFailed: (draftId: string) => void

  /** Update the response text of a draft (human editing) */
  updateDraftText: (draftId: string, newText: string) => void

  /** Replace operator-selected browser-send attachments */
  updateDraftAttachments: (draftId: string, attachments: NonNullable<EmailDraft['attachments']>) => Promise<void>

  /** Remove a draft entirely */
  removeDraft: (draftId: string) => void

  /** Clear all drafts older than 24 hours */
  cleanupOldDrafts: () => void
}

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()
const browserStorage: StateStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
}
const LEGACY_BROWSER_DRAFTS_KEY = 'aica-email-drafts-v1'

const asBrowserDraft = (draft: EmailDraft): BrowserEmailDraft => draft

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: [],

      addDraft: async (draft) => {
        set((state) => ({ drafts: [draft, ...state.drafts.filter((candidate) => candidate.id !== draft.id)] }))
        if (isBrowserProduct()) await getBrowserAgentdClient().saveEmailDraft(asBrowserDraft(draft))
      },

      approveDraft: (draftId) => {
        set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, status: 'approved' as const } : d) }))
        if (isBrowserProduct()) void getBrowserAgentdClient().updateEmailDraft(draftId, { status: 'approved' }).catch(() => undefined)
      },

      rejectDraft: (draftId) => {
        set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, status: 'rejected' as const } : d) }))
        if (isBrowserProduct()) void getBrowserAgentdClient().updateEmailDraft(draftId, { status: 'rejected' }).catch(() => undefined)
      },

      markDraftSent: (draftId) => {
        set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, status: 'sent' as const } : d) }))
      },

      markDraftFailed: (draftId) => {
        set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, status: 'failed' as const } : d) }))
      },

      updateDraftText: (draftId, newText) => {
        set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, responseText: newText } : d) }))
        if (isBrowserProduct()) void getBrowserAgentdClient().updateEmailDraft(draftId, { responseText: newText }).catch(() => undefined)
      },

      updateDraftAttachments: async (draftId, attachments) => {
        const previous = get().drafts.find((draft) => draft.id === draftId)?.attachments
        set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, attachments } : d) }))
        if (isBrowserProduct()) {
          try {
            await getBrowserAgentdClient().updateEmailDraft(draftId, { attachments })
          } catch (error) {
            set((state) => ({ drafts: state.drafts.map((d) => d.id === draftId ? { ...d, ...(previous ? { attachments: previous } : { attachments: undefined }) } : d) }))
            throw error
          }
        }
      },

      removeDraft: (draftId) => {
        set((state) => ({ drafts: state.drafts.filter((d) => d.id !== draftId) }))
        if (isBrowserProduct()) void getBrowserAgentdClient().deleteEmailDraft(draftId).catch(() => undefined)
      },

      cleanupOldDrafts: () => {
        const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000
        const current = useDraftStore.getState().drafts
        const retained = current.filter((d) => d.createdAt > twentyFourHoursAgo || d.status === 'pending_review')
        set({ drafts: retained })
        if (isBrowserProduct()) {
          for (const draft of current) if (!retained.some((item) => item.id === draft.id)) void getBrowserAgentdClient().deleteEmailDraft(draft.id).catch(() => undefined)
        }
      },
    }),
    {
      name: 'aica-email-drafts-v1',
      // Browser email drafts are durable agentd records; Electron retains its
      // existing local store until the native email worker is migrated.
      storage: createJSONStorage(() => isBrowserProduct() ? browserStorage : localStorage),
      partialize: (state) => ({
        // Only persist pending and approved drafts
        drafts: state.drafts.filter(
          (d) => d.status === 'pending_review' || d.status === 'approved'
        ),
      }),
    }
  )
)

if (isBrowserProduct()) {
  void (async () => {
    const client = getBrowserAgentdClient()
    const durable = await client.listEmailDrafts()
    const raw = localStorage.getItem(LEGACY_BROWSER_DRAFTS_KEY)
    let legacy: EmailDraft[] = []
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { state?: { drafts?: unknown } }
        if (Array.isArray(parsed?.state?.drafts)) legacy = parsed.state.drafts as EmailDraft[]
      } catch {
        // Keep malformed legacy data untouched for owner inspection.
      }
    }
    const migratedLegacy: EmailDraft[] = []
    if (legacy.length) {
      let migrated = true
      for (const draft of legacy) {
        try {
          await client.saveEmailDraft(asBrowserDraft(draft))
          migratedLegacy.push(draft)
        } catch { migrated = false }
      }
      if (migrated) localStorage.removeItem(LEGACY_BROWSER_DRAFTS_KEY)
    }
    const combined = [...durable]
    for (const draft of migratedLegacy) if (!combined.some((item) => item.id === draft.id)) combined.push(draft)
    useDraftStore.setState({ drafts: combined as EmailDraft[] })
  })().catch(() => undefined)
}
