/**
 * email-bridge.ts — Background polling service for the email channel.
 *
 * Responsibilities:
 *   - Periodically fetch new emails from the MCP email server
 *   - Deduplicate messages via Message-ID tracking
 *   - Dispatch new emails into the agent pipeline via `app:submit-message`
 *   - Manage connection lifecycle (connect/disconnect/reconnect)
 *   - Track unread count and last sync time
 *
 * Design:
 *   - Singleton pattern — one bridge instance per app lifecycle
 *   - Uses the existing MCP infrastructure (mcpStore) for server management
 *   - Integrates with emailStore for config and connection state
 *   - Safe-by-default: respects draftMode setting (no auto-send)
 */

import { useEmailStore, type EmailConnectionState } from '../stores/emailStore'
import { useChatStore } from '../stores/chatStore'
import {
  generateEmailSessionKey,
  convertEmailToLLMMessage,
  getEmailSystemPrompt,
  generateEmailSessionTitle,
  normalizeEmailAddress,
  validateEmailMessage,
  type EmailMessage,
} from '../lib/email-integration'
import electron from '../lib/electron'

/**
 * Minimum polling interval in milliseconds (30 seconds).
 * Prevents aggressive polling that could trigger rate limits.
 */
const MIN_POLLING_INTERVAL_MS = 30_000

/**
 * Maximum number of emails to fetch per polling cycle.
 * Prevents overwhelming the agent with a backlog of unread messages.
 */
const MAX_EMAILS_PER_POLL = 10

/**
 * Set of seen Message-IDs for deduplication.
 * Cleared on disconnect to allow re-processing on reconnect.
 */
const seenMessageIds = new Set<string>()

/**
 * EmailBridge — singleton that manages the email channel lifecycle.
 *
 * Usage:
 *   const bridge = EmailBridge.getInstance()
 *   await bridge.start()   // Begin polling
 *   await bridge.stop()    // Stop polling, cleanup
 */
export class EmailBridge {
  private static instance: EmailBridge | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private mcpServerId: string | null = null
  private isRunning = false

  private constructor() {}

  /**
   * Returns the singleton EmailBridge instance.
   * Creates one if it doesn't exist.
   */
  static getInstance(): EmailBridge {
    if (!EmailBridge.instance) {
      EmailBridge.instance = new EmailBridge()
    }
    return EmailBridge.instance
  }

  /**
   * Starts the email bridge: connects to the MCP email server and begins polling.
   *
   * @returns true if started successfully, false if already running or disabled
   */
  async start(): Promise<boolean> {
    if (this.isRunning) {
      console.log('[EmailBridge] Already running, ignoring start request')
      return false
    }

    const { config, setConnectionState } = useEmailStore.getState()

    if (!config.enabled) {
      console.log('[EmailBridge] Email channel is disabled, not starting')
      return false
    }

    this.isRunning = true
    setConnectionState({
      status: 'connecting',
      error: null,
      lastSyncAt: null,
      unreadCount: 0,
    })

    try {
      // Connect to the MCP email server
      await this.connectMcpServer()

      // Clear seen IDs on fresh start
      seenMessageIds.clear()

      // Begin polling
      this.scheduleNextPoll()

      setConnectionState({
        status: 'connected',
        error: null,
        lastSyncAt: Date.now(),
        unreadCount: 0,
      })

      console.log('[EmailBridge] Started successfully')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[EmailBridge] Failed to start:', errorMessage)

      setConnectionState({
        status: 'error',
        error: errorMessage,
        lastSyncAt: null,
        unreadCount: 0,
      })

      this.isRunning = false
      return false
    }
  }

  /**
   * Stops the email bridge: clears the poll timer and disconnects from the MCP server.
   */
  async stop(): Promise<void> {
    this.isRunning = false

    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }

    if (this.mcpServerId) {
      try {
        await electron.mcp.disconnect(this.mcpServerId)
      } catch {
        // Disconnect errors are non-fatal
      }
      this.mcpServerId = null
    }

    seenMessageIds.clear()

    useEmailStore.getState().resetConnectionState()
    console.log('[EmailBridge] Stopped')
  }

  /**
   * Returns whether the bridge is currently running.
   */
  get running(): boolean {
    return this.isRunning
  }

  /**
   * Connects to the MCP email server using the current configuration.
   *
   * If an email MCP server is already registered in mcpStore, reuses it.
   * Otherwise, creates a new internal email server connection.
   */
  private async connectMcpServer(): Promise<void> {
    const { useMcpStore } = await import('../stores/mcpStore')
    const mcpStore = useMcpStore.getState()

    // Check if an email MCP server already exists
    const existingEmailServer = mcpStore.servers.find(
      (s) => s.name.toLowerCase().includes('email')
    )

    if (existingEmailServer) {
      this.mcpServerId = existingEmailServer.id
      if (!existingEmailServer.connected) {
        await mcpStore.connectServer(existingEmailServer.id)
      }
      return
    }

    // Create a new email MCP server entry
    // The actual email server binary/script is expected to be available as 'mcp-email-server'
    // This follows the same pattern as the markitdown MCP server
    await mcpStore.addServer({
      name: 'email',
      description: 'Email MCP Server - IMAP/SMTP integration for email processing',
      type: 'stdio',
      command: 'mcp-email-server',
      args: [],
    })

    // The newly added server should be the last one with 'email' in the name
    const newServer = useMcpStore.getState().servers.find(
      (s) => s.name.toLowerCase() === 'email'
    )

    if (newServer) {
      this.mcpServerId = newServer.id
    }
  }

  /**
   * Schedules the next polling cycle based on the configured interval.
   * Respects the minimum interval of 30 seconds.
   */
  private scheduleNextPoll(): void {
    if (!this.isRunning) return

    const { config } = useEmailStore.getState()
    const intervalMs = Math.max(
      MIN_POLLING_INTERVAL_MS,
      config.pollingIntervalSeconds * 1000
    )

    this.pollTimer = setTimeout(async () => {
      if (!this.isRunning) return

      await this.pollInbox()
      this.scheduleNextPoll()
    }, intervalMs)
  }

  /**
   * Polls the inbox for new emails via the MCP email server.
   *
   * Process:
   *   1. Call the MCP email server's `fetch_emails` tool
   *   2. Filter out already-seen messages (deduplication)
   *   3. Validate each new email
   *   4. Convert to LLMMessage and dispatch to the agent pipeline
   *   5. Update connection state (unread count, last sync time)
   */
  private async pollInbox(): Promise<void> {
    if (!this.mcpServerId) {
      console.warn('[EmailBridge] No MCP server connected, skipping poll')
      return
    }

    try {
      // Fetch new emails via MCP tool
      const result = await electron.mcp.callTool(
        this.mcpServerId,
        'fetch_emails',
        {
          max_count: MAX_EMAILS_PER_POLL,
          unread_only: true,
        }
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = result?.result as any
      if (!response?.emails || !Array.isArray(response.emails)) {
        return
      }

      const emails: EmailMessage[] = response.emails
      let processedCount = 0

      for (const rawEmail of emails) {
        // Skip if already seen (deduplication via Message-ID)
        if (rawEmail.messageId && seenMessageIds.has(rawEmail.messageId)) {
          continue
        }

        // Validate the email
        const validation = validateEmailMessage(rawEmail)
        if (!validation.isValid) {
          console.warn(`[EmailBridge] Skipping invalid email: ${validation.error}`)
          continue
        }

        // Mark as seen
        if (rawEmail.messageId) {
          seenMessageIds.add(rawEmail.messageId)
        }

        // Process the email
        await this.processEmail(rawEmail)
        processedCount++
      }

      // Update connection state
      const { setConnectionState } = useEmailStore.getState()
      setConnectionState({
        status: 'connected',
        error: null,
        lastSyncAt: Date.now(),
        unreadCount: response.unread_count ?? 0,
      })

      if (processedCount > 0) {
        console.log(`[EmailBridge] Processed ${processedCount} new email(s)`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[EmailBridge] Poll error:', errorMessage)

      // Don't update connection state to error on transient failures
      // The next poll will retry
      if (errorMessage.includes('disconnect') || errorMessage.includes('ECONNREFUSED')) {
        useEmailStore.getState().setConnectionState({
          status: 'error',
          error: errorMessage,
          lastSyncAt: null,
          unreadCount: 0,
        })
      }
    }
  }

  /**
   * Processes a single email: creates/finds the session and dispatches to the agent.
   *
   * @param email - Validated email message
   */
  private async processEmail(email: EmailMessage): Promise<void> {
    const sessionKey = generateEmailSessionKey(email)
    const title = generateEmailSessionTitle(email)
    const llmMessage = convertEmailToLLMMessage(email)

    const { sessions, createSession, setActiveSession, addSessionMessage } = useChatStore.getState()

    // Find existing session by channel + contact_id
    let existingSession = sessions.find(
      (s) => s.channel === 'email' && s.contact_id === sessionKey.sender && s.title === title
    )

    // Also try matching by session key pattern in title or contact_id
    if (!existingSession) {
      existingSession = sessions.find(
        (s) => s.channel === 'email' && s.contact_id === sessionKey.sender
      )
    }

    let sessionId: string

    if (existingSession) {
      sessionId = existingSession.id
    } else {
      // Create new session for this email thread
      sessionId = createSession()
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                channel: 'email' as const,
                contact_id: sessionKey.sender,
                title,
              }
            : s
        ),
      }))
    }

    // Set as active session so the UI shows it
    setActiveSession(sessionId)

    // Add the email as a user message
    const content =
      typeof llmMessage.content === 'string'
        ? llmMessage.content
        : (llmMessage.content as Array<{ text: string }>).map((p) => p.text).join('\n')

    addSessionMessage(sessionId, {
      role: 'user',
      content,
      attachments: llmMessage.attachments,
    })

    // Dispatch to the agent pipeline if auto-reply is enabled
    const { config } = useEmailStore.getState()
    if (config.autoReplyMode) {
      // Also dispatch via the generic event so useAgent picks it up
      window.dispatchEvent(
        new CustomEvent('app:submit-message', {
          detail: {
            content: `📧 **Email** (${email.from}): ${email.subject}`,
            emailMessage: email,
          },
        })
      )
    }
  }
}
