/**
 * EmailSettingsPanel.tsx — Guided setup for the email support channel.
 *
 * UX goals:
 * - Minimize technical inputs for non-technical users.
 * - Hide IMAP/SMTP details by default.
 * - Provide plain-language connection testing before going live.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useEmailStore, EmailProvider } from '../../stores/emailStore'
import { Card } from '../primitives/Card'
import electron from '../../lib/electron'
import {
  Mail,
  Server,
  Clock,
  Shield,
  Save,
  AlertTriangle,
  CheckCircle,
  Info,
  ToggleLeft,
  ToggleRight,
  Sparkles,
  ChevronRight,
  Wrench,
  LogIn,
  LogOut,
} from 'lucide-react'

type TestState =
  | { status: 'idle' }
  | { status: 'running'; message: string }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string }

interface EmailConfigFields {
  accountName: string
  provider: EmailProvider
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  emailAddress: string
  userName: string
  imapTls: boolean
  smtpTls: boolean
  pollingIntervalSeconds: number
  enabled: boolean
  autoReplyMode: boolean
  draftMode: boolean
}

const PROVIDER_PRESETS: Record<EmailProvider, Pick<EmailConfigFields, 'imapHost' | 'imapPort' | 'smtpHost' | 'smtpPort' | 'imapTls' | 'smtpTls'>> = {
  'imap-smtp': {
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    imapTls: true,
    smtpTls: true,
  },
  'gmail-api': {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    imapTls: true,
    smtpTls: true,
  },
  'outlook-api': {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    imapTls: true,
    smtpTls: true,
  },
  'custom-mcp': {
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    imapTls: true,
    smtpTls: true,
  },
}

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase()
}

export function EmailSettingsPanel() {
  const {
    config,
    connectionState,
    setEnabled,
    setAutoReplyMode,
    setDraftMode,
    setProvider,
    setConnectionSettings,
    setPollingInterval,
  } = useEmailStore()

  const [showAdvanced, setShowAdvanced] = useState(false)

  const [localProvider, setLocalProvider] = useState<EmailProvider>(config.provider)
  const [localEmail, setLocalEmail] = useState(config.emailAddress)
  const [localAccountName, setLocalAccountName] = useState(config.accountName)
  const [localUserName, setLocalUserName] = useState(config.userName)
  const [localPassword, setLocalPassword] = useState('')

  const [localImapHost, setLocalImapHost] = useState(config.imapHost)
  const [localSmtpHost, setLocalSmtpHost] = useState(config.smtpHost)
  const [localImapPort, setLocalImapPort] = useState(config.imapPort)
  const [localSmtpPort, setLocalSmtpPort] = useState(config.smtpPort)
  const [localPollingInterval, setLocalPollingInterval] = useState(config.pollingIntervalSeconds)

  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [testState, setTestState] = useState<TestState>({ status: 'idle' })
  const [oauthStatus, setOauthStatus] = useState<{ signedIn: boolean; email: string | null }>({ signedIn: false, email: null })
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthBusy, setOauthBusy] = useState(false)

  const readyForAuth = useMemo(() => normalizeEmail(localEmail).includes('@'), [localEmail])
  const readyForVerify = useMemo(() => {
    if (localProvider === 'gmail-api') {
      return oauthStatus.signedIn || localPassword.trim().length > 0
    }
    return localPassword.trim().length > 0
  }, [localPassword, localProvider, oauthStatus.signedIn])
  const isGmailOAuthMode = localProvider === 'gmail-api' && oauthStatus.signedIn
  const canGoLive = readyForAuth && readyForVerify
  const isVerified = testState.status === 'success' || (config.enabled && connectionState.status === 'connected')

  useEffect(() => {
    setLocalProvider(config.provider)
    setLocalEmail(config.emailAddress)
    setLocalAccountName(config.accountName)
    setLocalUserName(config.userName)
    setLocalImapHost(config.imapHost)
    setLocalSmtpHost(config.smtpHost)
    setLocalImapPort(config.imapPort)
    setLocalSmtpPort(config.smtpPort)
    setLocalPollingInterval(config.pollingIntervalSeconds)
  }, [config])

  useEffect(() => {
    electron.secure.get('email_mcp_password').then((result) => {
      if (result.success && result.value) setLocalPassword(result.value)
    }).catch(() => {})
    electron.emailOAuth.initialize().then(setOauthStatus).catch(() => {})
    electron.secure.get('gmail_oauth_client_id').then((r) => {
      if (r.success && r.value) setOauthClientId(r.value)
    }).catch(() => {})
    electron.secure.get('gmail_oauth_client_secret').then((r) => {
      if (r.success && r.value) setOauthClientSecret(r.value)
    }).catch(() => {})
  }, [])

  const applyProvider = (provider: EmailProvider) => {
    setLocalProvider(provider)
    const preset = PROVIDER_PRESETS[provider]
    setLocalImapHost(preset.imapHost)
    setLocalImapPort(preset.imapPort)
    setLocalSmtpHost(preset.smtpHost)
    setLocalSmtpPort(preset.smtpPort)
  }

  const persistSettings = async () => {
    const emailAddress = normalizeEmail(localEmail)
    const userName = localUserName.trim() || emailAddress
    const accountName = localAccountName.trim() || 'default'

    setProvider(localProvider)
    setConnectionSettings({
      accountName,
      emailAddress,
      userName,
      imapHost: localImapHost.trim(),
      smtpHost: localSmtpHost.trim(),
      imapPort: localImapPort,
      smtpPort: localSmtpPort,
    })
    setPollingInterval(localPollingInterval)
    if (localPassword.trim()) {
      await electron.secure.set('email_mcp_password', localPassword.trim())
    }
    if (oauthClientId.trim()) {
      await electron.secure.set('gmail_oauth_client_id', oauthClientId.trim())
    }
    if (oauthClientSecret.trim()) {
      await electron.secure.set('gmail_oauth_client_secret', oauthClientSecret.trim())
    }
  }

  const handleGoogleOAuthSignIn = async () => {
    setOauthBusy(true)
    try {
      const status = await electron.emailOAuth.signInGoogle(oauthClientId.trim(), oauthClientSecret.trim())
      setOauthStatus(status)
      if (status.email) setLocalEmail(status.email)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTestState({ status: 'error', message: `Google OAuth failed: ${message}` })
    } finally {
      setOauthBusy(false)
    }
  }

  const handleGoogleOAuthSignOut = async () => {
    setOauthBusy(true)
    try {
      await electron.emailOAuth.signOut()
      setOauthStatus({ signedIn: false, email: null })
    } finally {
      setOauthBusy(false)
    }
  }

  const buildRuntimeConfig = () => {
    const emailAddress = normalizeEmail(localEmail)
    const userName = localUserName.trim() || emailAddress
    const accountName = localAccountName.trim() || 'default'

    return {
      provider: localProvider,
      command: 'uvx',
      args: ['mcp-email-server==0.6.2', 'stdio'],
      pollingIntervalSeconds: Math.max(30, localPollingInterval),
      accountName,
      unreadOnly: false,
      maxEmailsPerPoll: 5,
      env: {
        MCP_EMAIL_SERVER_ACCOUNT_NAME: accountName,
        MCP_EMAIL_SERVER_FULL_NAME: emailAddress.split('@')[0] || 'support',
        MCP_EMAIL_SERVER_EMAIL_ADDRESS: emailAddress,
        MCP_EMAIL_SERVER_USER_NAME: userName,
        MCP_EMAIL_SERVER_PASSWORD: localPassword.trim(),
        MCP_EMAIL_SERVER_IMAP_HOST: localImapHost.trim(),
        MCP_EMAIL_SERVER_IMAP_PORT: String(localImapPort),
        MCP_EMAIL_SERVER_IMAP_SSL: 'true',
        MCP_EMAIL_SERVER_SMTP_HOST: localSmtpHost.trim(),
        MCP_EMAIL_SERVER_SMTP_PORT: String(localSmtpPort),
        MCP_EMAIL_SERVER_SMTP_START_SSL: localSmtpPort === 587 ? 'true' : 'false',
        MCP_EMAIL_SERVER_SMTP_SSL: localSmtpPort === 465 ? 'true' : 'false',
        MCP_EMAIL_SERVER_ENABLE_ATTACHMENT_DOWNLOAD: 'false',
        MCP_EMAIL_SERVER_SAVE_TO_SENT: 'true',
      },
    }
  }

  const handleTestConnection = async () => {
    if (!readyForAuth || !readyForVerify) {
      setTestState({ status: 'error', message: 'Please complete email and app password before testing.' })
      return
    }

    if (config.enabled && connectionState.status === 'connected') {
      setTestState({
        status: 'success',
        message: 'Email channel is already connected and running.'
      })
      return
    }

    setTestState({ status: 'running', message: 'Testing mailbox connection…' })

    try {
      await persistSettings()

      await electron.email.stop()
      await electron.email.configure(buildRuntimeConfig())

      const started = await electron.email.start()
      if (!started.success) {
        throw new Error(started.error || 'Unable to start email channel.')
      }

      const state = await electron.email.getState()
      if (state.status !== 'connected') {
        throw new Error(state.error || 'Connection did not reach connected state.')
      }

      await electron.email.stop()

      setTestState({
        status: 'success',
        message: 'Connection successful. You can now enable the email channel.'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTestState({
        status: 'error',
        message: `Connection failed: ${message}`
      })
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    setSaveStatus('idle')
    try {
      await persistSettings()
      setSaveStatus('success')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch {
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

  const isConnected = connectionState.status === 'connected'
  const isError = connectionState.status === 'error'

  return (
    <div className="space-y-6">
      <div className="bg-[var(--color-brand-teal)]/10 border border-[var(--color-brand-teal)]/30 rounded-xl p-4 flex gap-3">
        <Sparkles size={18} className="text-[var(--color-brand-teal)] shrink-0 mt-0.5" />
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          <strong>Easy setup:</strong> choose provider, enter your email + app password, test connection, then go live.
          Advanced SMTP/IMAP settings are optional.
        </p>
      </div>

      {isConnected && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 flex items-center gap-2">
          <CheckCircle size={16} className="text-green-400" />
          <span className="text-xs text-green-300">Connected — Last sync: {connectionState.lastSyncAt ? new Date(connectionState.lastSyncAt).toLocaleTimeString() : 'Never'}</span>
        </div>
      )}
      {isError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-red-400" />
          <span className="text-xs text-red-300">{connectionState.error || 'Connection error'}</span>
        </div>
      )}

      <Card variant="glass" padding="md" className="space-y-6">
        <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
          <span className="text-[var(--color-brand-teal)]">1. Provider</span>
          <ChevronRight size={12} />
          <span className={canGoLive ? 'text-[var(--color-brand-teal)]' : ''}>2. Authenticate</span>
          <ChevronRight size={12} />
          <span className={isVerified ? 'text-[var(--color-brand-teal)]' : ''}>3. Verify & Go Live</span>
        </div>
        <p className="text-xs text-[var(--color-text-dim)]">
          {!isVerified
            ? 'Run Test Connection to complete verification and unlock Go Live.'
            : 'Verified. You can now safely go live.'}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {([
            ['gmail-api', 'Gmail'],
            ['outlook-api', 'Outlook'],
            ['imap-smtp', 'Other Email'],
          ] as Array<[EmailProvider, string]>).map(([provider, label]) => {
            const active = localProvider === provider
            return (
              <button
                key={provider}
                onClick={() => {
                  applyProvider(provider)
                }}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  active
                    ? 'border-[var(--color-brand-teal)] bg-[var(--color-brand-teal)]/10'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-brand-teal)]/60'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Mail size={14} className={active ? 'text-[var(--color-brand-teal)]' : 'text-[var(--color-text-dim)]'} />
                  <span className="text-sm font-semibold text-[var(--color-text-primary)]">{label}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-dim)]">
                  {provider === 'imap-smtp' ? 'Generic provider with quick preset fallback' : 'Quick preset with safe defaults'}
                </p>
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-[var(--color-border)]">
          <div>
            <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">Email Address</label>
            <input
              type="email"
              value={localEmail}
              onChange={(e) => setLocalEmail(e.target.value)}
              className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)]"
              placeholder="you@company.com"
            />
          </div>
          {!isGmailOAuthMode && (
            <div>
              <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">App Password / Token</label>
              <input
                type="password"
                value={localPassword}
                onChange={(e) => setLocalPassword(e.target.value)}
                className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)]"
                placeholder="Securely stored in OS keychain"
              />
              <p className="text-xs text-[var(--color-text-dim)] mt-1 flex items-center gap-1"><Shield size={12} />Secure storage enabled</p>
            </div>
          )}
        </div>

        {localProvider === 'gmail-api' && (
          <div className="space-y-3 pt-2 border-t border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-dim)]">
              Google OAuth (recommended): avoids manual IMAP app-password setup.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <input
                type="text"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)]"
                placeholder="Google OAuth Client ID"
              />
              <input
                type="password"
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)]"
                placeholder="Google OAuth Client Secret (optional)"
              />
            </div>
            <div className="flex items-center gap-3">
              {!oauthStatus.signedIn ? (
                <button
                  onClick={handleGoogleOAuthSignIn}
                  disabled={oauthBusy || !oauthClientId.trim()}
                  className="flex items-center gap-2 bg-[var(--color-brand-teal)]/20 hover:bg-[var(--color-brand-teal)]/30 text-[var(--color-brand-teal)] px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  <LogIn size={14} />
                  Sign in with Google
                </button>
              ) : (
                <button
                  onClick={handleGoogleOAuthSignOut}
                  disabled={oauthBusy}
                  className="flex items-center gap-2 bg-red-500/15 hover:bg-red-500/25 text-red-300 px-4 py-2 rounded-lg text-sm font-semibold"
                >
                  <LogOut size={14} />
                  Disconnect Google
                </button>
              )}
              <span className="text-xs text-[var(--color-text-dim)]">
                {oauthStatus.signedIn ? `Connected as ${oauthStatus.email || 'Google account'}` : 'Not connected'}
              </span>
            </div>
          </div>
        )}

        {!isGmailOAuthMode && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">Account Name</label>
              <input
                type="text"
                value={localAccountName}
                onChange={(e) => setLocalAccountName(e.target.value)}
                className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)]"
                placeholder="default"
              />
            </div>
            <div>
              <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">Login Username (Optional)</label>
              <input
                type="text"
                value={localUserName}
                onChange={(e) => setLocalUserName(e.target.value)}
                className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)]"
                placeholder="Uses email by default"
              />
            </div>
          </div>
        )}

        {!isGmailOAuthMode && (
          <div className="pt-2 border-t border-[var(--color-border)]">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            >
              <Wrench size={13} />
              {showAdvanced ? 'Hide advanced server settings' : 'Show advanced server settings'}
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[var(--color-text-muted)] text-xs mb-1">IMAP Host</label>
                    <input
                      type="text"
                      value={localImapHost}
                      onChange={(e) => setLocalImapHost(e.target.value)}
                      className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)]"
                      placeholder="imap.example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-[var(--color-text-muted)] text-xs mb-1">IMAP Port</label>
                    <input
                      type="number"
                      value={localImapPort}
                      onChange={(e) => setLocalImapPort(parseInt(e.target.value) || 993)}
                      className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)]"
                    />
                  </div>
                  <div>
                    <label className="block text-[var(--color-text-muted)] text-xs mb-1">SMTP Host</label>
                    <input
                      type="text"
                      value={localSmtpHost}
                      onChange={(e) => setLocalSmtpHost(e.target.value)}
                      className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)]"
                      placeholder="smtp.example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-[var(--color-text-muted)] text-xs mb-1">SMTP Port</label>
                    <input
                      type="number"
                      value={localSmtpPort}
                      onChange={(e) => setLocalSmtpPort(parseInt(e.target.value) || 587)}
                      className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)]"
                    />
                  </div>
                </div>
                <p className="text-xs text-[var(--color-text-dim)] flex items-center gap-1"><Server size={12} />Use this only if your provider needs custom server values.</p>
              </div>
            )}
          </div>
        )}

        <div className="pt-2 border-t border-[var(--color-border)]">
          <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2 flex items-center gap-2">
            <Clock size={16} className="text-[var(--color-text-muted)]" />
            Polling Interval
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={30}
              max={300}
              step={30}
              value={localPollingInterval}
              onChange={(e) => setLocalPollingInterval(parseInt(e.target.value))}
              className="flex-1 accent-[var(--color-brand-teal)]"
            />
            <span className="text-xs text-[var(--color-text-muted)] w-16 text-right">{localPollingInterval}s</span>
          </div>
        </div>

        <div className="pt-2 border-t border-[var(--color-border)] space-y-3">
          <button
            onClick={handleTestConnection}
            disabled={!readyForAuth || !readyForVerify || testState.status === 'running'}
            className="w-full flex items-center justify-center gap-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {testState.status === 'running' ? 'Testing connection…' : 'Test Connection'}
          </button>

          {testState.status !== 'idle' && (
            <div className={`text-xs rounded-lg px-3 py-2 ${
              testState.status === 'success'
                ? 'bg-green-500/10 text-green-300 border border-green-500/30'
                : testState.status === 'error'
                  ? 'bg-red-500/10 text-red-300 border border-red-500/30'
                  : 'bg-blue-500/10 text-blue-300 border border-blue-500/30'
            }`}>
              {testState.message}
            </div>
          )}
        </div>

        <div className="space-y-3 pt-2 border-t border-[var(--color-border)]">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Draft Mode</p>
              <p className="text-xs text-[var(--color-text-dim)]">Recommended: keep ON for safe review</p>
            </div>
            <button onClick={() => setDraftMode(!config.draftMode)} className="text-[var(--color-brand-teal)]">
              {config.draftMode ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Auto-Reply</p>
              <p className="text-xs text-[var(--color-text-dim)]">Only enable after successful testing</p>
            </div>
            <button onClick={() => setAutoReplyMode(!config.autoReplyMode)} className="text-[var(--color-brand-teal)]">
              {config.autoReplyMode ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Enable Email Channel</p>
              <p className="text-xs text-[var(--color-text-dim)]">Turns on background email processing</p>
            </div>
            <button onClick={() => setEnabled(!config.enabled)} className={config.enabled ? 'text-green-400' : 'text-[var(--color-text-muted)]'}>
              {config.enabled ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>
        </div>

        <div className="pt-4 border-t border-[var(--color-border)] flex items-center justify-between">
          {saveStatus === 'success' && (
            <span className="text-xs text-green-400 flex items-center gap-1">
              <CheckCircle size={12} /> Settings saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle size={12} /> Failed to save
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary)]/90 text-white px-6 py-2 rounded-lg font-bold text-sm transition-all shadow-md shadow-[var(--color-primary)]/20 disabled:opacity-50"
            >
              <Save size={16} />
              {isSaving ? 'Saving...' : 'Save Setup'}
            </button>
          </div>
        </div>

        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 text-xs text-[var(--color-text-dim)] flex gap-2">
          <Info size={14} className="shrink-0 mt-0.5" />
          OAuth-based one-click sign-in for Gmail/Outlook is planned. For now, use app passwords/tokens.
        </div>
      </Card>
    </div>
  )
}
