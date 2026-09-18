/**
 * EmailSettingsPanel.tsx — Guided setup for the email support channel.
 *
 * UX goals:
 * - Minimize technical inputs for non-technical users.
 * - Hide IMAP/SMTP details by default.
 * - Provide plain-language connection testing before going live.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { flushEmailSettingsPersistence, useEmailStore, type EmailProvider, type GmailAuthMode } from '../../stores/emailStore'
import { Card } from '../primitives/Card'
import electron from '../../lib/electron'
import { buildEmailRuntimeConfig } from '../../lib/email-runtime'
import { getBrowserAgentdClient } from '../../lib/browser-agentd-client'
import { isElectron } from '../../lib/electron'
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
    setGmailAuthMode,
    setConnectionSettings,
    setPollingInterval,
  } = useEmailStore()

  const [showAdvanced, setShowAdvanced] = useState(false)

  const [localProvider, setLocalProvider] = useState<EmailProvider>(config.provider)
  const [localGmailAuthMode, setLocalGmailAuthMode] = useState<GmailAuthMode>(config.gmailAuthMode)
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
  const [oauthStatus, setOauthStatus] = useState<{ signedIn: boolean; email: string | null; requiresReauthentication: boolean }>({ signedIn: false, email: null, requiresReauthentication: false })
  const [oauthBusy, setOauthBusy] = useState(false)

  const browserRuntime = !isElectron()
  const readyForAuth = useMemo(() => normalizeEmail(localEmail).includes('@'), [localEmail])
  const wantsGmailOAuth = localProvider === 'gmail-api' && localGmailAuthMode === 'google-oauth'
  const readyForVerify = useMemo(() => {
    if (wantsGmailOAuth) {
      return oauthStatus.signedIn
    }
    // Browser keeps password in agentd's credential store. Let server report
    // missing credentials instead of requiring renderer to read them back.
    return isElectron() ? localPassword.trim().length > 0 : true
  }, [localPassword, oauthStatus.signedIn, wantsGmailOAuth])
  const canGoLive = readyForAuth && readyForVerify
  const transportVerified = testState.status === 'success' || (config.enabled && connectionState.status === 'connected')
  const isVerified = transportVerified

  useEffect(() => {
    setLocalProvider(config.provider)
    setLocalGmailAuthMode(config.gmailAuthMode)
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
    if (isElectron()) {
      electron.secure.get('email_mcp_password').then((result) => {
        if (result.success && result.value) setLocalPassword(result.value)
      }).catch(() => {})
      electron.emailOAuth.initialize().then(setOauthStatus).catch(() => {})
    } else {
      getBrowserAgentdClient().getGmailOAuthStatus().then(setOauthStatus).catch(() => {})
    }
  }, [])

  const applyProvider = (provider: EmailProvider) => {
    setLocalProvider(provider)
    if (provider === 'gmail-api') {
      setLocalGmailAuthMode('app-password')
    }
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
    setGmailAuthMode(localGmailAuthMode)
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
      if (isElectron()) {
        await electron.secure.set('email_mcp_password', localPassword.trim())
      } else {
        const client = getBrowserAgentdClient()
        // The browser daemon has separate IMAP and SMTP workers. Store the
        // same user-entered app password in both OS-backed slots; the page
        // never reads either value back.
        const value = localPassword.trim()
        const [imap, smtp] = await Promise.all([
          client.setCredential('email_imap_password', value),
          client.setCredential('email_smtp_password', value),
        ])
        if (!imap.success || !smtp.success) throw new Error('Email credential could not be stored securely')
      }
    }
    // Setter persistence is asynchronous in browser mode. Flush before tests
    // or a success toast can race agentd and read the previous configuration.
    await flushEmailSettingsPersistence()
  }

  const handleGoogleOAuthSignIn = async () => {
    setOauthBusy(true)
    try {
      let status
      if (isElectron()) {
        status = await electron.emailOAuth.signInGoogle()
      } else {
        const client = getBrowserAgentdClient()
        const started = await client.startGmailOAuth()
        const popup = window.open(started.authorizationUrl, 'aica-google-oauth', 'popup,width=640,height=760')
        if (!popup) throw new Error('Allow pop-ups for the local AICA workspace, then try again.')
        const deadline = Math.min(started.expiresAt, Date.now() + 3 * 60 * 1000)
        status = await new Promise<typeof oauthStatus>((resolve, reject) => {
          let timer: number | undefined
          const poll = async () => {
            try {
              const next = await client.getGmailOAuthStatus()
              setOauthStatus(next)
              if (next.signedIn) { if (timer !== undefined) window.clearTimeout(timer); resolve(next); return }
              if (Date.now() >= deadline) { if (timer !== undefined) window.clearTimeout(timer); reject(new Error('Google Sign-In timed out.')) ; return }
              timer = window.setTimeout(() => { void poll() }, 1000)
            } catch (error) {
              if (timer !== undefined) window.clearTimeout(timer)
              reject(error)
            }
          }
          void poll()
        })
      }
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
      if (isElectron()) await electron.emailOAuth.signOut()
      else await getBrowserAgentdClient().signOutGmailOAuth()
      setOauthStatus({ signedIn: false, email: null, requiresReauthentication: false })
    } finally {
      setOauthBusy(false)
    }
  }

  const buildRuntimeConfig = () => {
    const emailAddress = normalizeEmail(localEmail)
    const userName = localUserName.trim() || emailAddress
    const accountName = localAccountName.trim() || 'default'

    return buildEmailRuntimeConfig({
      provider: localProvider,
      gmailAuthMode: localGmailAuthMode,
      oauthSignedIn: oauthStatus.signedIn,
      emailAddress,
      userName,
      accountName,
      imapHost: localImapHost.trim(),
      imapPort: localImapPort,
      smtpHost: localSmtpHost.trim(),
      smtpPort: localSmtpPort,
      imapTls: true,
      smtpTls: localSmtpPort === 587,
      pollingIntervalSeconds: Math.max(30, localPollingInterval),
      password: localPassword.trim(),
      unreadOnly: false,
      maxEmailsPerPoll: 5,
    })
  }

  const handleTestConnection = async () => {
    if (!isElectron()) {
      if (!readyForAuth) {
        setTestState({ status: 'error', message: 'Please enter a valid email address before testing.' })
        return
      }
      setTestState({ status: 'running', message: 'Testing secure mailbox transport…' })
      try {
        await persistSettings()
        const result = await getBrowserAgentdClient().testEmail()
        setTestState({
          status: 'success',
          message: result.transport.gmailApi
            ? `Gmail API reachable for ${result.oauth?.email || 'the connected account'}. The daemon mailbox worker and approved-draft delivery still require their explicit browser gates.`
            : `Secure transport reachable (IMAP ${result.transport.imap?.tls ? 'TLS' : 'plain'}, SMTP ${result.transport.smtp?.tls ? 'TLS' : 'plain'}). The daemon mailbox worker and approved-draft delivery still require their explicit browser gates.`,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setTestState({ status: 'error', message: `Connection failed: ${message}` })
      }
      return
    }
    if (!readyForAuth || !readyForVerify) {
      setTestState({
        status: 'error',
        message: wantsGmailOAuth
          ? 'Please sign in with Google before testing.'
          : 'Please complete email and app password before testing.'
      })
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
          {browserRuntime
            ? <><strong>Browser setup:</strong> agentd stores mailbox settings and credentials, performs a bounded secure-transport or Gmail API probe, and runs text-only IMAP/Gmail workers when their OAuth/app-password, TLS, enable, and approval gates pass.</>
            : <><strong>Client-side setup:</strong> choose a mailbox preset, use an app password by default, test the local IMAP/SMTP bridge, then go live.</>}
          {' '}Keep Draft Mode on and Auto-Reply off until verification is complete.
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
            ? (browserRuntime
              ? (transportVerified ? 'Transport verified. Browser IMAP polling and approved-draft delivery remain protected by their explicit gates.' : 'Run Test Connection to verify the secure transport. Browser IMAP polling and approved-draft delivery remain protected by their explicit gates.')
              : 'Run Test Connection to complete verification and unlock Go Live.')
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
                  {provider === 'gmail-api'
                    ? (browserRuntime ? 'Recommended: agentd app-password transport probe' : 'Recommended: local Gmail app-password flow')
                    : provider === 'imap-smtp'
                      ? 'Generic provider with manual server settings'
                      : 'Preset server values with safe defaults'}
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
          {!wantsGmailOAuth && (
            <div>
              <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">App Password / Token</label>
              <input
                type="password"
                value={localPassword}
                onChange={(e) => setLocalPassword(e.target.value)}
                className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)]"
                placeholder={browserRuntime ? 'Write-only through local agentd' : 'Securely stored in OS keychain'}
              />
              <p className="text-xs text-[var(--color-text-dim)] mt-1 flex items-center gap-1"><Shield size={12} />Secure storage enabled</p>
            </div>
          )}
        </div>

        {localProvider === 'gmail-api' && (
          <div className="space-y-3 pt-2 border-t border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-dim)]">
              {browserRuntime
                ? 'Browser mode stores Gmail settings in agentd. Use Google Sign-In for the Gmail API worker, or an app password for bounded IMAP/SMTP.'
                : 'Gmail stays client-side here. The recommended path is an app password over IMAP/SMTP.'}
            </p>
            <p className="text-xs text-[var(--color-text-dim)]">
              {browserRuntime
                ? 'Google Sign-In opens in a separate browser tab; the refresh token stays in the agentd OS credential store.'
                : 'Google sign-in remains optional if runtime OAuth is configured, but it is not required for the local bridge.'}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                onClick={() => setLocalGmailAuthMode('app-password')}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  localGmailAuthMode === 'app-password'
                    ? 'border-[var(--color-brand-teal)] bg-[var(--color-brand-teal)]/10'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-brand-teal)]/60'
                }`}
              >
                <p className="text-sm font-semibold text-[var(--color-text-primary)]">App Password</p>
                <p className="mt-1 text-xs text-[var(--color-text-dim)]">{browserRuntime ? 'Stores a write-only credential for agentd transport verification.' : 'Recommended for client-side QA and production bring-up.'}</p>
              </button>
              <button
                onClick={() => setLocalGmailAuthMode('google-oauth')}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  localGmailAuthMode === 'google-oauth'
                    ? 'border-[var(--color-brand-teal)] bg-[var(--color-brand-teal)]/10'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-brand-teal)]/60'
                }`}
              >
                <p className="text-sm font-semibold text-[var(--color-text-primary)]">Google Sign-In</p>
                <p className="mt-1 text-xs text-[var(--color-text-dim)]">{browserRuntime ? 'Uses the local agentd OAuth callback and Gmail API; refresh tokens never enter page state.' : 'Only use this when app-managed Gmail OAuth is configured.'}</p>
              </button>
            </div>
            {localGmailAuthMode === 'app-password' && (
              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 text-xs text-[var(--color-text-dim)]">
                {browserRuntime
                  ? 'Gmail preset values are already loaded. Use an app password for the bounded transport probe, text-only mailbox polling, and approved-draft delivery.'
                  : 'Gmail preset values are already loaded. Use a Gmail app password and keep Draft Mode on for the first end-to-end run.'}
              </div>
            )}
            {localGmailAuthMode === 'google-oauth' && (
            <div className="flex items-center gap-3">
              {!oauthStatus.signedIn ? (
                <button
                  onClick={handleGoogleOAuthSignIn}
                  disabled={oauthBusy}
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
                {oauthStatus.requiresReauthentication
                  ? 'Authorization expired — sign in again'
                  : oauthStatus.signedIn ? `Connected as ${oauthStatus.email || 'Google account'}` : 'Not connected'}
              </span>
            </div>
            )}
          </div>
        )}

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

        <div className="pt-2 border-t border-[var(--color-border)]">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <Wrench size={13} />
            {showAdvanced ? 'Hide server settings' : 'Show server settings'}
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
              <p className="text-xs text-[var(--color-text-dim)] flex items-center gap-1"><Server size={12} />Gmail preset loads `imap.gmail.com:993` and `smtp.gmail.com:587` automatically. Override only if needed.</p>
            </div>
          )}
        </div>

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
              <p className="text-xs text-[var(--color-text-dim)]">{browserRuntime ? 'Consumes queued agentd events into review sessions; it does not generate or send automatic replies. Polling has separate enable, TLS, and credential gates.' : 'Only enable after successful testing'}</p>
            </div>
            <button onClick={() => setAutoReplyMode(!config.autoReplyMode)} className="text-[var(--color-brand-teal)]">
              {config.autoReplyMode ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Enable Email Channel</p>
              <p className="text-xs text-[var(--color-text-dim)]">{browserRuntime ? 'Starts bounded daemon IMAP polling for app-password mode or Gmail API polling after Google Sign-In; each path has separate TLS, credential, and enable gates.' : 'Turns on background email processing'}</p>
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
          {browserRuntime
            ? 'Browser mode uses authenticated local agentd for bounded text-only IMAP/Gmail polling and approved SMTP/Gmail delivery. HTML/multipart, attachments, custom MCP, and unsupported providers remain fail-closed; the daemon connects directly to the selected mailbox provider.'
            : 'This email channel runs as a local client connector. No hosted mail server is required for Gmail, Outlook, or other IMAP/SMTP providers.'}
        </div>
      </Card>
    </div>
  )
}
