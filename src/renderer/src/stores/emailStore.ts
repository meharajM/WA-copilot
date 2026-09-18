/**
 * emailStore.ts — Zustand store for email channel configuration and state.
 *
 * Owns: email provider config, connection state, polling settings.
 * Mirrors the pattern used by whatsappStore for consistency.
 *
 * Per zustand-stores.md: stores do not import each other, no class instances
 * are persisted, and all async callbacks read state via getState().
 */

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import type { EmailSettings } from '../../../shared/native-bridge'
import { getBrowserAgentdClient } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'

/** Supported email providers for MCP integration */
export type EmailProvider = 'imap-smtp' | 'gmail-api' | 'outlook-api' | 'custom-mcp'
export type GmailAuthMode = 'app-password' | 'google-oauth'

/** Connection state for the email channel */
export interface EmailConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  /** Last successful sync timestamp */
  lastSyncAt: number | null
  /** Number of unread messages in the last sync */
  unreadCount: number
}

/** Email channel configuration — persisted */
export interface EmailConfig extends EmailSettings {
  /** Logical mailbox account label for MCP server */
  accountName: string
  /** Selected email provider type */
  provider: EmailProvider
  /** Gmail auth strategy when Gmail is selected */
  gmailAuthMode: GmailAuthMode
  /** IMAP server hostname (for imap-smtp provider) */
  imapHost: string
  /** IMAP server port */
  imapPort: number
  /** SMTP server hostname */
  smtpHost: string
  /** SMTP server port */
  smtpPort: number
  /** Email address used for authentication */
  emailAddress: string
  /** Optional login username (defaults to email address) */
  userName: string
  /** Whether to use TLS for IMAP */
  imapTls: boolean
  /** Whether to use TLS for SMTP */
  smtpTls: boolean
  /** Polling interval in seconds (minimum 30) */
  pollingIntervalSeconds: number
  /** Whether email channel is enabled */
  enabled: boolean
  /** Whether auto-reply mode is active */
  autoReplyMode: boolean
  /** Whether to create drafts instead of sending directly */
  draftMode: boolean
}

interface EmailState {
  /** Runtime connection state (not persisted) */
  connectionState: EmailConnectionState

  /** Persisted email configuration */
  config: EmailConfig

  // ── Persisted actions ──────────────────────────────────────────────────

  /** Enable or disable the email channel */
  setEnabled: (enabled: boolean) => void

  /** Toggle auto-reply mode (responds to all incoming emails) */
  setAutoReplyMode: (enabled: boolean) => void

  /** Toggle draft mode (create drafts instead of sending directly) */
  setDraftMode: (enabled: boolean) => void

  /** Update email provider type */
  setProvider: (provider: EmailProvider) => void

  /** Update Gmail auth mode */
  setGmailAuthMode: (mode: GmailAuthMode) => void

  /** Update IMAP/SMTP connection settings */
  setConnectionSettings: (settings: Partial<Pick<EmailConfig, 'accountName' | 'imapHost' | 'imapPort' | 'smtpHost' | 'smtpPort' | 'emailAddress' | 'userName' | 'imapTls' | 'smtpTls'>>) => void

  /** Update polling interval */
  setPollingInterval: (seconds: number) => void

  // ── Runtime-only actions (not persisted) ───────────────────────────────

  /** Called by email bridge when connection state changes */
  setConnectionState: (state: EmailConnectionState) => void

  /** Reset connection state to disconnected */
  resetConnectionState: () => void
}

const DEFAULT_CONFIG: EmailConfig = {
  accountName: 'default',
  provider: 'imap-smtp',
  gmailAuthMode: 'app-password',
  imapHost: '',
  imapPort: 993,
  smtpHost: '',
  smtpPort: 587,
  emailAddress: '',
  userName: '',
  imapTls: true,
  smtpTls: true,
  pollingIntervalSeconds: 60,
  enabled: false,
  autoReplyMode: false,
  draftMode: true, // Safe default: drafts only until user approves
}

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()
const browserStorage: StateStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
}

// Browser settings are durable agentd state, not renderer state. Serialize
// writes so rapid form edits cannot finish out of order and overwrite newer
// values. Keep this queue module-local; it is only a transport concern.
let browserHydrationPromise: Promise<void> = Promise.resolve()
let browserHydrated = !isBrowserProduct()
let browserDirtyBeforeHydration = false
let applyingBrowserSettings = false
let browserSaveQueue: Promise<void> = Promise.resolve()

const queueBrowserSettingsSave = (config: EmailConfig): void => {
  if (!isBrowserProduct() || !browserHydrated) return
  const queued = browserSaveQueue
    .catch(() => undefined)
    .then(() => getBrowserAgentdClient().saveEmailSettings(config))
    .then(() => undefined)
  browserSaveQueue = queued
  void queued.catch(() => undefined)
}

/** Wait until browser email settings writes have reached authenticated agentd. */
export const flushEmailSettingsPersistence = async (): Promise<void> => {
  if (!isBrowserProduct()) return
  await browserHydrationPromise
  await browserSaveQueue
}

export const useEmailStore = create<EmailState>()(
  persist(
    (set) => ({
      connectionState: {
        status: 'disconnected',
        error: null,
        lastSyncAt: null,
        unreadCount: 0,
      },
      config: DEFAULT_CONFIG,

      setEnabled: (enabled) =>
        set((state) => ({ config: { ...state.config, enabled } })),

      setAutoReplyMode: (enabled) =>
        set((state) => ({ config: { ...state.config, autoReplyMode: enabled } })),

      setDraftMode: (enabled) =>
        set((state) => ({ config: { ...state.config, draftMode: enabled } })),

      setProvider: (provider) =>
        set((state) => ({ config: { ...state.config, provider } })),

      setGmailAuthMode: (gmailAuthMode) =>
        set((state) => ({ config: { ...state.config, gmailAuthMode } })),

      setConnectionSettings: (settings) =>
        set((state) => ({
          config: { ...state.config, ...settings },
        })),

      setPollingInterval: (seconds) =>
        set((state) => ({
          config: {
            ...state.config,
            pollingIntervalSeconds: Math.max(30, seconds), // Minimum 30s
          },
        })),

      setConnectionState: (state) => set({ connectionState: state }),

      resetConnectionState: () =>
        set({
          connectionState: {
            status: 'disconnected',
            error: null,
            lastSyncAt: null,
            unreadCount: 0,
          },
        }),
    }),
    {
      name: 'aica-email-v1',
      // Browser settings are owned by authenticated agentd, never renderer storage.
      storage: createJSONStorage(() => isBrowserProduct() ? browserStorage : localStorage),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<EmailState> | undefined
        return {
          ...currentState,
          ...persisted,
          config: {
            ...currentState.config,
            ...(persisted?.config || {}),
          },
        }
      },
      partialize: (state) => ({
        config: state.config,
        // connectionState is NOT persisted — always fresh on startup
      }),
    }
  )
)

if (isBrowserProduct()) {
  browserHydrationPromise = getBrowserAgentdClient().getEmailSettings().then((config) => {
    if (!browserDirtyBeforeHydration) {
      applyingBrowserSettings = true
      useEmailStore.setState({ config })
      applyingBrowserSettings = false
    }
    browserHydrated = true
    if (browserDirtyBeforeHydration) queueBrowserSettingsSave(useEmailStore.getState().config)
  }).catch(() => {
    browserHydrated = true
    if (browserDirtyBeforeHydration) queueBrowserSettingsSave(useEmailStore.getState().config)
  })
  useEmailStore.subscribe((state, previous) => {
    if (state.config === previous.config || applyingBrowserSettings) return
    if (!browserHydrated) {
      browserDirtyBeforeHydration = true
      return
    }
    queueBrowserSettingsSave(state.config)
  })
}
