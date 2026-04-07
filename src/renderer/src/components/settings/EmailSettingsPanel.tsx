/**
 * EmailSettingsPanel.tsx — Settings UI for email channel configuration.
 *
 * Allows users to:
 *   - Configure IMAP/SMTP connection settings
 *   - Set polling interval
 *   - Toggle email channel on/off
 *   - Enable/disable auto-reply and draft modes
 *
 * Sensitive credentials (passwords, OAuth tokens) are stored via the
 * secure storage API (OS keychain), NOT in localStorage.
 */

import React, { useState, useEffect } from 'react';
import { useEmailStore, EmailProvider } from '../../stores/emailStore';
import { Card } from '../primitives/Card';
import electron from '../../lib/electron';
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
} from 'lucide-react';

/** Preset configurations for common email providers */
const PROVIDER_PRESETS: Record<string, Pick<EmailConfigFields, 'imapHost' | 'imapPort' | 'smtpHost' | 'smtpPort' | 'imapTls' | 'smtpTls'>> = {
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
};

interface EmailConfigFields {
  accountName: string;
  provider: EmailProvider;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  emailAddress: string;
  userName: string;
  imapTls: boolean;
  smtpTls: boolean;
  pollingIntervalSeconds: number;
  enabled: boolean;
  autoReplyMode: boolean;
  draftMode: boolean;
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
  } = useEmailStore();

  const [localEmail, setLocalEmail] = useState(config.emailAddress);
  const [localAccountName, setLocalAccountName] = useState(config.accountName);
  const [localUserName, setLocalUserName] = useState(config.userName);
  const [localPassword, setLocalPassword] = useState('');
  const [localImapHost, setLocalImapHost] = useState(config.imapHost);
  const [localSmtpHost, setLocalSmtpHost] = useState(config.smtpHost);
  const [localImapPort, setLocalImapPort] = useState(config.imapPort);
  const [localSmtpPort, setLocalSmtpPort] = useState(config.smtpPort);
  const [localPollingInterval, setLocalPollingInterval] = useState(config.pollingIntervalSeconds);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Sync local state when config changes
  useEffect(() => {
    setLocalEmail(config.emailAddress);
    setLocalAccountName(config.accountName);
    setLocalUserName(config.userName);
    setLocalImapHost(config.imapHost);
    setLocalSmtpHost(config.smtpHost);
    setLocalImapPort(config.imapPort);
    setLocalSmtpPort(config.smtpPort);
    setLocalPollingInterval(config.pollingIntervalSeconds);
  }, [config]);

  useEffect(() => {
    electron.secure.get('email_mcp_password').then((result) => {
      if (result.success && result.value) {
        setLocalPassword(result.value)
      }
    }).catch(() => {
      // Ignore secure store read failures in UI bootstrap.
    })
  }, [])

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      setConnectionSettings({
        accountName: localAccountName.trim() || 'default',
        emailAddress: localEmail.trim(),
        userName: localUserName.trim(),
        imapHost: localImapHost.trim(),
        smtpHost: localSmtpHost.trim(),
        imapPort: localImapPort,
        smtpPort: localSmtpPort,
      });
      setPollingInterval(localPollingInterval);
      if (localPassword.trim()) {
        await electron.secure.set('email_mcp_password', localPassword)
      }
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch {
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  /** Apply preset values for the selected provider */
  const handleProviderChange = (provider: EmailProvider) => {
    setProvider(provider);
    const preset = PROVIDER_PRESETS[provider];
    if (preset) {
      setLocalImapHost(preset.imapHost);
      setLocalImapPort(preset.imapPort);
      setLocalSmtpHost(preset.smtpHost);
      setLocalSmtpPort(preset.smtpPort);
    }
  };

  const isConnected = connectionState.status === 'connected';
  const isError = connectionState.status === 'error';

  return (
    <div className="space-y-6">
      {/* Info banner */}
      <div className="bg-[var(--color-brand-teal)]/10 border border-[var(--color-brand-teal)]/30 rounded-xl p-4 flex gap-3">
        <Info size={18} className="text-[var(--color-brand-teal)] shrink-0 mt-0.5" />
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          <strong>Email Channel:</strong> Connect your email account to enable AI-powered email support.
          Responses are created as drafts by default for review before sending.
          Credentials are stored securely in your OS keychain.
        </p>
      </div>

      {/* Connection status indicator */}
      {isConnected && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 flex items-center gap-2">
          <CheckCircle size={16} className="text-green-400" />
          <span className="text-xs text-green-300">Connected — Last sync: {connectionState.lastSyncAt ? new Date(connectionState.lastSyncAt).toLocaleTimeString() : 'Never'}</span>
          {connectionState.unreadCount > 0 && (
            <span className="ml-auto text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded-full">
              {connectionState.unreadCount} unread
            </span>
          )}
        </div>
      )}
      {isError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-red-400" />
          <span className="text-xs text-red-300">{connectionState.error || 'Connection error'}</span>
        </div>
      )}

      {/* Provider selection */}
      <Card variant="glass" padding="md" className="space-y-5">
        <div>
          <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2 flex items-center gap-2">
            <Mail size={16} className="text-[var(--color-text-muted)]" />
            Email Provider
          </label>
          <select
            value={config.provider}
            onChange={(e) => handleProviderChange(e.target.value as EmailProvider)}
            className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors appearance-none"
          >
            <option value="imap-smtp">IMAP/SMTP (Generic)</option>
            <option value="gmail-api">Gmail API</option>
            <option value="outlook-api">Outlook/Office 365</option>
            <option value="custom-mcp">Custom MCP Server</option>
          </select>
        </div>

        {/* Email address */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">
              Account Name
            </label>
            <input
              type="text"
              value={localAccountName}
              onChange={(e) => setLocalAccountName(e.target.value)}
              className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
              placeholder="default"
            />
          </div>

          <div>
            <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">
              Login Username (Optional)
            </label>
            <input
              type="text"
              value={localUserName}
              onChange={(e) => setLocalUserName(e.target.value)}
              className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
              placeholder="Uses email address by default"
            />
          </div>
        </div>

        <div>
          <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">
            Email Address
          </label>
          <input
            type="email"
            value={localEmail}
            onChange={(e) => setLocalEmail(e.target.value)}
            className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
            placeholder="you@company.com"
          />
        </div>

        <div>
          <label className="block text-[var(--color-text-primary)] text-sm font-bold mb-2">
            App Password / Token
          </label>
          <input
            type="password"
            value={localPassword}
            onChange={(e) => setLocalPassword(e.target.value)}
            className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
            placeholder="Stored in OS secure storage"
          />
          <p className="text-xs text-[var(--color-text-dim)] mt-1">
            Stored via secure OS-backed encryption. Not written to normal app config.
          </p>
        </div>

        {/* IMAP/SMTP settings — shown for generic provider */}
        {config.provider === 'imap-smtp' && (
          <div className="space-y-4 pt-2 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-2 text-sm font-bold text-[var(--color-text-primary)]">
              <Server size={16} className="text-[var(--color-text-muted)]" />
              Server Settings
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[var(--color-text-muted)] text-xs mb-1">IMAP Host</label>
                <input
                  type="text"
                  value={localImapHost}
                  onChange={(e) => setLocalImapHost(e.target.value)}
                  className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
                  placeholder="imap.example.com"
                />
              </div>
              <div>
                <label className="block text-[var(--color-text-muted)] text-xs mb-1">IMAP Port</label>
                <input
                  type="number"
                  value={localImapPort}
                  onChange={(e) => setLocalImapPort(parseInt(e.target.value) || 993)}
                  className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
                />
              </div>
              <div>
                <label className="block text-[var(--color-text-muted)] text-xs mb-1">SMTP Host</label>
                <input
                  type="text"
                  value={localSmtpHost}
                  onChange={(e) => setLocalSmtpHost(e.target.value)}
                  className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
                  placeholder="smtp.example.com"
                />
              </div>
              <div>
                <label className="block text-[var(--color-text-muted)] text-xs mb-1">SMTP Port</label>
                <input
                  type="number"
                  value={localSmtpPort}
                  onChange={(e) => setLocalSmtpPort(parseInt(e.target.value) || 587)}
                  className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[var(--color-brand-teal)] transition-colors"
                />
              </div>
            </div>

            <p className="text-xs text-[var(--color-text-dim)] flex items-center gap-1">
              <Shield size={12} />
              Password is stored securely in your OS keychain (not in localStorage).
            </p>
          </div>
        )}

        {/* Polling interval */}
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
            <span className="text-xs text-[var(--color-text-muted)] w-16 text-right">
              {localPollingInterval}s
            </span>
          </div>
          <p className="text-xs text-[var(--color-text-dim)] mt-1">
            How often to check for new emails. Minimum 30 seconds.
          </p>
        </div>

        {/* Toggle switches */}
        <div className="space-y-3 pt-2 border-t border-[var(--color-border)]">
          {/* Draft mode toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Draft Mode</p>
              <p className="text-xs text-[var(--color-text-dim)]">Create drafts for review instead of sending directly</p>
            </div>
            <button
              onClick={() => setDraftMode(!config.draftMode)}
              className="text-[var(--color-brand-teal)]"
            >
              {config.draftMode ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>

          {/* Auto-reply toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Auto-Reply</p>
              <p className="text-xs text-[var(--color-text-dim)]">Automatically respond to incoming emails</p>
            </div>
            <button
              onClick={() => setAutoReplyMode(!config.autoReplyMode)}
              className="text-[var(--color-brand-teal)]"
            >
              {config.autoReplyMode ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>

          {/* Channel enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text-primary)] font-medium">Enable Email Channel</p>
              <p className="text-xs text-[var(--color-text-dim)]">Activate email processing</p>
            </div>
            <button
              onClick={() => setEnabled(!config.enabled)}
              className={config.enabled ? 'text-green-400' : 'text-[var(--color-text-muted)]'}
            >
              {config.enabled ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
            </button>
          </div>
        </div>

        {/* Save button */}
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
          <div className="ml-auto">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary)]/90 text-white px-6 py-2 rounded-lg font-bold text-sm transition-all shadow-md shadow-[var(--color-primary)]/20 disabled:opacity-50"
            >
              <Save size={16} />
              {isSaving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
