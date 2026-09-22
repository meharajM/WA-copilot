import { useEffect, useState } from 'react'
import type { CredentialKey, NativeHealth } from '../../shared/native-bridge'
import { tauriNativeBridge, type NativeBackgroundPolicy, type NativeChatHistoryCutover, type NativeContinuityPreview, type NativeCredentialContinuityPreview, type NativeServiceStatus, type NativeSettingsPersonaCutover } from './lib/tauri-native-bridge'

const CREDENTIALS: Array<{ key: CredentialKey; label: string }> = [
  { key: 'openai_api_key', label: 'OpenAI key' },
  { key: 'gemini_api_key', label: 'Gemini key' },
  { key: 'openrouter_api_key', label: 'OpenRouter key' },
  { key: 'email_mcp_password', label: 'Email legacy password' },
  { key: 'email_imap_password', label: 'Email IMAP password' },
  { key: 'email_smtp_password', label: 'Email SMTP password' },
  { key: 'gmail_oauth_client_id', label: 'Gmail OAuth client ID' },
  { key: 'whatsapp_cloud_access_token', label: 'WhatsApp Cloud access token' },
  { key: 'whatsapp_cloud_app_secret', label: 'WhatsApp Cloud app secret' },
  { key: 'whatsapp_cloud_verify_token', label: 'WhatsApp Cloud verify token' },
]

const messageFrom = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
)

export default function NativeHostDiagnostics() {
  const [version, setVersion] = useState('loading')
  const [agentdOrigin, setAgentdOrigin] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [health, setHealth] = useState<NativeHealth>({ status: 'unavailable', error: 'Checking agentd…' })
  const [service, setService] = useState<NativeServiceStatus | null>(null)
  const [backgroundPolicy, setBackgroundPolicy] = useState<NativeBackgroundPolicy | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [credential, setCredential] = useState<CredentialKey>('openai_api_key')
  const [credentialValue, setCredentialValue] = useState('')
  const [credentialState, setCredentialState] = useState<'unknown' | 'present' | 'missing'>('unknown')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [continuityPreview, setContinuityPreview] = useState<NativeContinuityPreview | null>(null)
  const [migrationId, setMigrationId] = useState<string | null>(null)
  const [settingsPersonaCutover, setSettingsPersonaCutover] = useState<NativeSettingsPersonaCutover | null>(null)
  const [chatHistoryCutover, setChatHistoryCutover] = useState<NativeChatHistoryCutover | null>(null)
  const [credentialContinuityPreview, setCredentialContinuityPreview] = useState<NativeCredentialContinuityPreview | null>(null)

  const refresh = async () => {
    try { setHealth(await tauriNativeBridge.health()) }
    catch (reason) { setHealth({ status: 'unavailable', error: messageFrom(reason, 'Native host unavailable') }) }
  }

  const refreshBackgroundPolicy = async () => {
    try { setBackgroundPolicy(await tauriNativeBridge.backgroundPolicy()) }
    catch (reason) { setBackgroundPolicy(null); setError(messageFrom(reason, 'Background policy unavailable')) }
  }

  const refreshService = async () => {
    try { setService(await tauriNativeBridge.serviceStatus()) }
    catch (reason) { setService({ supported: true, installed: false, running: false, taskName: 'AICA Native Companion', message: messageFrom(reason, 'Windows service status unavailable') }) }
  }

  useEffect(() => {
    void tauriNativeBridge.appVersion().then(setVersion).catch(() => setVersion('unavailable'))
    void tauriNativeBridge.agentdOrigin().then((origin) => setAgentdOrigin(`${origin}/tauri.html`)).catch(() => setAgentdOrigin(null))
    void refresh()
    void refreshService()
    void refreshBackgroundPolicy()
  }, [])

  const startAgent = async () => {
    setBusy('agent-start'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.agentdStart()
      if (!result.success) throw new Error(result.error || 'Background agent could not start')
      await refresh()
      setNotice('Background processing started. You can close the browser UI and customer work will continue.')
    } catch (reason) { setError(messageFrom(reason, 'Background agent could not start')) }
    finally { setBusy(null) }
  }

  const stopAgent = async () => {
    if (!window.confirm('Stop background customer processing? The browser workspace will become unavailable until you start the agent again.')) return
    setBusy('agent-stop'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.agentdStop()
      if (!result.success) throw new Error(result.error || 'Background agent could not stop')
      await refresh()
      setNotice('Background processing stopped. Start it again before opening the browser workspace.')
    } catch (reason) { setError(messageFrom(reason, 'Background agent could not stop')) }
    finally { setBusy(null) }
  }

  const toggleBackgroundPolicy = async (keepRunning: boolean) => {
    setBusy('background-policy'); setError(null); setNotice(null)
    try {
      setBackgroundPolicy(await tauriNativeBridge.setBackgroundPolicy(keepRunning))
      setNotice(keepRunning ? 'Background mode enabled. Closing the UI will not stop customer processing.' : 'Background mode disabled. Use Stop background agent to end processing explicitly.')
    } catch (reason) { setError(messageFrom(reason, 'Could not save background mode')) }
    finally { setBusy(null) }
  }

  const installService = async () => {
    setBusy('service-install'); setError(null); setNotice(null)
    try {
      setService(await tauriNativeBridge.serviceInstall())
      setNotice('AICA will start with this Windows user and recover the local service after a companion failure')
    } catch (reason) { setError(messageFrom(reason, 'Windows service registration failed')) }
    finally { setBusy(null) }
  }

  const uninstallService = async () => {
    if (!window.confirm('Remove AICA automatic startup for this Windows user? The browser workspace and current agentd process will remain available until stopped.')) return
    setBusy('service-uninstall'); setError(null); setNotice(null)
    try {
      setService(await tauriNativeBridge.serviceUninstall())
      setNotice('AICA automatic startup was removed for this Windows user')
    } catch (reason) { setError(messageFrom(reason, 'Windows service removal failed')) }
    finally { setBusy(null) }
  }

  const choose = async (kind: 'file' | 'folder') => {
    setBusy(kind); setError(null); setNotice(null)
    try {
      const path = kind === 'file' ? await tauriNativeBridge.selectFile({ title: 'Choose a file' }) : await tauriNativeBridge.selectFolder()
      setSelectedPath(path)
      setNotice(path ? `${kind === 'file' ? 'File' : 'Folder'} selected for the browser workflow` : 'Selection canceled')
    } catch (reason) { setError(messageFrom(reason, `${kind} picker unavailable`)) }
    finally { setBusy(null) }
  }

  const openBrowserWorkspace = async () => {
    setBusy('browser'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.openBrowserWorkspace()
      if (!result.success) throw new Error(result.error || 'Browser workspace unavailable')
      setNotice('Opened the product workspace in your default browser')
    } catch (reason) { setError(messageFrom(reason, 'Browser workspace unavailable')) }
    finally { setBusy(null) }
  }

  const openAgentdDataFolder = async () => {
    setBusy('data-folder'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.openAgentdDataFolder()
      if (!result.success) throw new Error(result.error || 'Agentd data folder unavailable')
      setNotice('Opened the agentd data folder in the native file manager')
    } catch (reason) { setError(messageFrom(reason, 'Agentd data folder unavailable')) }
    finally { setBusy(null) }
  }

  const revealPairingCode = async () => {
    setBusy('pairing'); setError(null); setNotice(null)
    try {
      setPairingCode(await tauriNativeBridge.agentdPairingCode())
      setNotice('Pairing code revealed locally. Enter it in the browser workspace; it is not copied or persisted.')
    } catch (reason) {
      setPairingCode(null)
      setError(messageFrom(reason, 'Pairing code unavailable; it may already be used or expired'))
    } finally { setBusy(null) }
  }

  const checkCredential = async () => {
    setBusy('credential'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.hasCredential(credential)
      if (!result.success) throw new Error(result.error || 'Credential store unavailable')
      setCredentialState(result.exists ? 'present' : 'missing')
      setNotice(`${CREDENTIALS.find((item) => item.key === credential)?.label} presence checked without reading its value`)
    } catch (reason) { setCredentialState('unknown'); setError(messageFrom(reason, 'Credential store unavailable')) }
    finally { setBusy(null) }
  }

  const reauthenticateCredential = async () => {
    if (!credentialValue) { setError('Enter the credential value to store securely'); return }
    setBusy('credential-save'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.setCredential(credential, credentialValue)
      if (!result.success) throw new Error(result.error || 'Credential store unavailable')
      setCredentialValue('')
      setCredentialState('present')
      setNotice(`${CREDENTIALS.find((item) => item.key === credential)?.label} stored in agentd's OS credential store; value cleared from the form`)
    } catch (reason) { setError(messageFrom(reason, 'Credential reauthentication failed')) }
    finally { setBusy(null) }
  }

  const previewContinuity = async () => {
    setBusy('continuity-preview'); setError(null); setNotice(null)
    try {
      const sourceRoot = await tauriNativeBridge.selectFolder()
      if (!sourceRoot) { setNotice('Selection canceled'); return }
      const preview = await tauriNativeBridge.continuityPreview(sourceRoot)
      setContinuityPreview(preview)
      setNotice(`Validated ${preview.entries.length} non-secret Electron store${preview.entries.length === 1 ? '' : 's'} for isolated staging`)
    } catch (reason) { setError(messageFrom(reason, 'Continuity preview unavailable')) }
    finally { setBusy(null) }
  }

  const previewCredentialContinuity = async () => {
    setBusy('credential-continuity-preview'); setError(null); setNotice(null)
    try {
      const sourceRoot = await tauriNativeBridge.selectFolder()
      if (!sourceRoot) { setNotice('Selection canceled'); return }
      const preview = await tauriNativeBridge.credentialContinuityPreview(sourceRoot)
      setCredentialContinuityPreview(preview)
      const count = preview.stores.reduce((total, store) => total + store.entries.length, 0)
      setNotice(`Found ${count} credential entr${count === 1 ? 'y' : 'ies'} requiring owner reauthentication; no secret values were read back`)
    } catch (reason) {
      setCredentialContinuityPreview(null)
      setError(messageFrom(reason, 'Credential continuity preview unavailable'))
    } finally { setBusy(null) }
  }


  const stageContinuity = async () => {
    if (!continuityPreview) return
    setBusy('continuity-import'); setError(null); setNotice(null)
    try {
      const result = await tauriNativeBridge.continuityImport(continuityPreview.previewId)
      setMigrationId(result.migrationId)
      setNotice('Validated data staged. Live agentd data was not changed.')
    } catch (reason) { setError(messageFrom(reason, 'Continuity staging unavailable')) }
    finally { setBusy(null) }
  }

  const rollbackContinuity = async () => {
    if (!migrationId) return
    setBusy('continuity-rollback'); setError(null); setNotice(null)
    try {
      await tauriNativeBridge.continuityRollback(migrationId)
      setMigrationId(null); setContinuityPreview(null)
      setNotice('Staged continuity snapshot rolled back')
    } catch (reason) { setError(messageFrom(reason, 'Continuity rollback unavailable')) }
    finally { setBusy(null) }
  }

  const confirmSettingsPersona = async () => {
    if (!continuityPreview) return
    setBusy('settings-persona-confirm'); setError(null); setNotice(null)
    try { setSettingsPersonaCutover(await tauriNativeBridge.settingsPersonaConfirm(continuityPreview.previewId)); setNotice('Metadata cutover confirmed. Apply only after reviewing the staged stores.') }
    catch (reason) { setError(messageFrom(reason, 'Metadata cutover confirmation unavailable')) }
    finally { setBusy(null) }
  }

  const applySettingsPersona = async () => {
    if (!settingsPersonaCutover?.confirmationToken) return
    setBusy('settings-persona-apply'); setError(null); setNotice(null)
    try { setSettingsPersonaCutover(await tauriNativeBridge.settingsPersonaApply(settingsPersonaCutover.previewId, settingsPersonaCutover.confirmationToken)); setNotice('Settings/persona metadata applied to agentd') }
    catch (reason) { setError(messageFrom(reason, 'Metadata cutover failed')) }
    finally { setBusy(null) }
  }

  const confirmChatHistory = async () => {
    if (!continuityPreview) return
    setBusy('chat-history-confirm'); setError(null); setNotice(null)
    try {
      setChatHistoryCutover(await tauriNativeBridge.chatHistoryConfirm(continuityPreview.previewId))
      setNotice('Chat history cutover confirmed. Apply only after reviewing the staged stores.')
    } catch (reason) { setError(messageFrom(reason, 'Chat-history cutover confirmation unavailable')) }
    finally { setBusy(null) }
  }

  const applyChatHistory = async () => {
    if (!chatHistoryCutover?.confirmationToken) return
    setBusy('chat-history-apply'); setError(null); setNotice(null)
    try {
      setChatHistoryCutover(await tauriNativeBridge.chatHistoryApply(chatHistoryCutover.previewId, chatHistoryCutover.confirmationToken))
      setNotice('Chat history applied to agentd')
    } catch (reason) { setError(messageFrom(reason, 'Chat-history cutover failed')) }
    finally { setBusy(null) }
  }

  const refreshChatHistoryStatus = async () => {
    if (!continuityPreview) return
    setBusy('chat-history-status'); setError(null); setNotice(null)
    try {
      setChatHistoryCutover(await tauriNativeBridge.chatHistoryStatus(continuityPreview.previewId))
      setNotice('Chat-history cutover status refreshed')
    } catch (reason) { setError(messageFrom(reason, 'Chat-history status unavailable')) }
    finally { setBusy(null) }
  }

  const rollbackChatHistory = async () => {
    if (!chatHistoryCutover) return
    setBusy('chat-history-rollback'); setError(null); setNotice(null)
    try {
      setChatHistoryCutover(await tauriNativeBridge.chatHistoryRollback(chatHistoryCutover.previewId))
      setNotice('Chat history cutover rolled back')
    } catch (reason) { setError(messageFrom(reason, 'Chat-history rollback unavailable')) }
    finally { setBusy(null) }
  }

  const rollbackSettingsPersona = async () => {
    if (!settingsPersonaCutover) return
    setBusy('settings-persona-rollback'); setError(null); setNotice(null)
    try { setSettingsPersonaCutover(await tauriNativeBridge.settingsPersonaRollback(settingsPersonaCutover.previewId)); setNotice('Settings/persona metadata rolled back') }
    catch (reason) { setError(messageFrom(reason, 'Metadata rollback unavailable')) }
    finally { setBusy(null) }
  }

  const healthy = health.status === 'ready'
  return (
    <main className="pilot-shell">
      <header className="pilot-header">
        <div><p className="pilot-kicker">AICA / NATIVE HOST</p><h1>Native capabilities</h1><p className="pilot-lede">Use Edge or Chrome for the product workspace. This companion only exposes OS capabilities.</p></div>
        <div className="pilot-runtime-badge"><span className={`pilot-dot ${healthy ? 'pilot-dot-live' : ''}`} aria-hidden="true" />{healthy ? 'READY' : 'UNAVAILABLE'}<span className="pilot-slash">/</span>v{version}</div>
      </header>
      <section className="pilot-grid" aria-label="Native host capabilities">
        <article className={`pilot-panel pilot-health ${healthy ? 'is-ready' : 'is-unavailable'}`}>
          <div className="pilot-panel-heading"><div><p className="pilot-label">01 / local service</p><h2>Agentd status</h2></div><span className="pilot-status" role="status">{healthy ? 'READY' : 'UNAVAILABLE'}</span></div>
          <p className="pilot-copy">The daemon owns product data, workflows and credentials. Its lifetime is independent from this window.</p><p className="pilot-health-readout">{health.error || 'Native companion connected to agentd.'}</p>
          <p className="pilot-path" title={agentdOrigin || undefined}>{agentdOrigin ? `Browser workspace: ${agentdOrigin}` : 'Browser workspace URL unavailable until agentd is ready'}</p>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void openBrowserWorkspace()} disabled={busy !== null || !agentdOrigin}>{busy === 'browser' ? 'Opening…' : 'Open browser workspace'}</button><button type="button" className="pilot-button" onClick={() => void openAgentdDataFolder()} disabled={busy !== null}>{busy === 'data-folder' ? 'Opening…' : 'Open agentd data folder'}</button><button type="button" className="pilot-button" onClick={() => void revealPairingCode()} disabled={busy !== null || !agentdOrigin}>{busy === 'pairing' ? 'Reading…' : pairingCode ? 'Refresh pairing code' : 'Show pairing code'}</button><button type="button" className="pilot-button" onClick={() => void refresh()} disabled={busy !== null}>Refresh status</button></div>
          {pairingCode && <p className="pilot-pairing-code" aria-live="polite"><span>Browser pairing code</span><strong>{pairingCode}</strong></p>}
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">02 / background lifecycle</p><h2>Keep processing when UI closes</h2></div><span className="pilot-index">OWNER CONTROL</span></div>
          <p className="pilot-copy">The browser is only the user interface. Keep the local agent running to continue resolving customer queries after closing the tab or native window.</p>
          <div className="pilot-actions">
            <button type="button" className="pilot-button pilot-button-primary" onClick={() => void startAgent()} disabled={busy !== null}>{busy === 'agent-start' ? 'Starting…' : 'Start background agent'}</button>
            <button type="button" className="pilot-button" onClick={() => void stopAgent()} disabled={busy !== null || !healthy}>{busy === 'agent-stop' ? 'Stopping…' : 'Stop background agent'}</button>
          </div>
          <label className="pilot-toggle-row">
            <input type="checkbox" checked={backgroundPolicy?.keepRunning ?? true} onChange={(event) => void toggleBackgroundPolicy(event.target.checked)} disabled={busy !== null || backgroundPolicy === null} />
            <span><strong>Keep running in background</strong><small>{backgroundPolicy?.keepRunning === false ? 'Closing native diagnostics stops the companion; browser-tab close never stops agentd.' : 'Recommended for customer support; closing the browser or native window does not stop processing.'}</small></span>
          </label>
          <p className="pilot-health-readout" role="status">{healthy ? 'Background agent is ready' : 'Background agent is stopped or unavailable'}</p>
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">03 / Windows lifecycle</p><h2>Sign-in service</h2></div><span className="pilot-index">USER SERVICE</span></div>
          <p className="pilot-copy">Register the lightweight native companion for this Windows user. It starts the local agentd service at sign-in, keeps the browser workspace independent, and retries after a companion failure.</p>
          <p className="pilot-health-readout" role="status">{service?.message || 'Checking Windows service registration…'}</p>
          {service?.supported && <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void installService()} disabled={busy !== null}>{busy === 'service-install' ? 'Registering…' : service.installed ? 'Re-register service' : 'Install sign-in service'}</button>{service.installed && <button type="button" className="pilot-button" onClick={() => void uninstallService()} disabled={busy !== null}>{busy === 'service-uninstall' ? 'Removing…' : 'Remove sign-in service'}</button>}<span className="pilot-key-state" role="status">{service.installed ? (service.running ? 'Registered · running' : 'Registered') : 'Not registered'}</span></div>}
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">04 / file access</p><h2>Owner-selected paths</h2></div><span className="pilot-index">OS PICKER</span></div>
          <p className="pilot-copy">Choose a path for an owner-approved native workflow. Product uploads use the browser picker; arbitrary filesystem access is not exposed.</p>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void choose('file')} disabled={busy !== null}>{busy === 'file' ? 'Opening…' : 'Choose file'}</button><button type="button" className="pilot-button" onClick={() => void choose('folder')} disabled={busy !== null}>{busy === 'folder' ? 'Opening…' : 'Choose folder'}</button></div>
          <p className="pilot-path" aria-live="polite">{selectedPath || 'No path selected yet'}</p>
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">05 / credential store</p><h2>Presence only</h2></div><span className="pilot-index">OS STORE</span></div>
          <p className="pilot-copy">Check presence or re-enter a credential after Electron migration. Values go directly to agentd's OS store and are cleared from this form after success.</p>
          <div className="pilot-form-row"><label htmlFor="native-credential">Credential</label><select id="native-credential" value={credential} onChange={(event) => { setCredential(event.target.value as CredentialKey); setCredentialState('unknown'); setCredentialValue('') }} disabled={busy !== null}>{CREDENTIALS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
          <div className="pilot-form-row"><label htmlFor="native-credential-value">Value</label><input id="native-credential-value" type="password" autoComplete="new-password" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} disabled={busy !== null} placeholder="Enter to reauthenticate" /></div>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void checkCredential()} disabled={busy !== null}>{busy === 'credential' ? 'Checking…' : 'Check presence'}</button><button type="button" className="pilot-button" onClick={() => void reauthenticateCredential()} disabled={busy !== null || !credentialValue}>{busy === 'credential-save' ? 'Saving…' : 'Store securely'}</button><span className="pilot-key-state" role="status">{credentialState === 'present' ? 'Stored' : credentialState === 'missing' ? 'Not stored' : 'Not checked'}</span></div>
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">06 / continuity</p><h2>Stage Electron data</h2></div><span className="pilot-index">OWNER ACTION</span></div>
          <p className="pilot-copy">Preview and stage only allowlisted, non-secret stores. Live cutovers require separate owner confirmation; credentials require separate reauthentication.</p>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void previewContinuity()} disabled={busy !== null}>{busy === 'continuity-preview' ? 'Validating…' : 'Preview Electron data'}</button></div>
          {continuityPreview && <div className="pilot-continuity" aria-live="polite"><p>{continuityPreview.entries.map(entry => `${entry.id} (${entry.byteSize} bytes)`).join(' · ')}</p><p className="pilot-copy">Review this list before staging. Credentials and OAuth migration remain deferred. Chat history and settings/persona cutovers run independently.</p><div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void stageContinuity()} disabled={busy !== null || Boolean(migrationId)}>{busy === 'continuity-import' ? 'Staging…' : 'Stage validated data'}</button>{migrationId && !settingsPersonaCutover && <button type="button" className="pilot-button" onClick={() => void confirmSettingsPersona()} disabled={busy !== null}>{busy === 'settings-persona-confirm' ? 'Confirming…' : 'Confirm settings/persona'}</button>}{migrationId && (!chatHistoryCutover || (chatHistoryCutover.state === 'confirmed' && !chatHistoryCutover.confirmationToken && chatHistoryCutover.requiresReconfirmation)) && <button type="button" className="pilot-button" onClick={() => void confirmChatHistory()} disabled={busy !== null}>{busy === 'chat-history-confirm' ? 'Confirming…' : chatHistoryCutover ? 'Confirm chat history again' : 'Confirm chat history'}</button>}{migrationId && !settingsPersonaCutover?.backupSha256 && !chatHistoryCutover?.backupSha256 && <button type="button" className="pilot-button" onClick={() => void rollbackContinuity()} disabled={busy !== null}>{busy === 'continuity-rollback' ? 'Rolling back…' : 'Rollback staging'}</button>}</div>{settingsPersonaCutover && <div className="pilot-actions"><span className="pilot-key-state" role="status">Settings/persona: {settingsPersonaCutover.state}</span>{settingsPersonaCutover.confirmationToken && <button type="button" className="pilot-button pilot-button-primary" onClick={() => void applySettingsPersona()} disabled={busy !== null}>{busy === 'settings-persona-apply' ? 'Applying…' : 'Apply metadata cutover'}</button>}{settingsPersonaCutover.state === 'applied' && <button type="button" className="pilot-button" onClick={() => void rollbackSettingsPersona()} disabled={busy !== null}>{busy === 'settings-persona-rollback' ? 'Rolling back…' : 'Rollback metadata'}</button>}</div>}{chatHistoryCutover && <div className="pilot-actions"><span className="pilot-key-state" role="status">Chat history: {chatHistoryCutover.state}</span>{chatHistoryCutover.confirmationToken && <button type="button" className="pilot-button pilot-button-primary" onClick={() => void applyChatHistory()} disabled={busy !== null}>{busy === 'chat-history-apply' ? 'Applying…' : 'Apply chat history'}</button>}{chatHistoryCutover.backupSha256 && chatHistoryCutover.state !== 'rolled-back' && <button type="button" className="pilot-button" onClick={() => void rollbackChatHistory()} disabled={busy !== null}>{busy === 'chat-history-rollback' ? 'Rolling back…' : 'Rollback chat history'}</button>}<button type="button" className="pilot-button" onClick={() => void refreshChatHistoryStatus()} disabled={busy !== null}>{busy === 'chat-history-status' ? 'Refreshing…' : 'Refresh chat-history status'}</button></div>}</div>}
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">07 / credential continuity</p><h2>Reauthentication only</h2></div><span className="pilot-index">NO SECRET READ</span></div>
          <p className="pilot-copy">Electron safe-storage values cannot be transferred safely. Review which credentials need to be entered again through the browser's secure agentd flow; no values are shown or copied.</p>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void previewCredentialContinuity()} disabled={busy !== null}>{busy === 'credential-continuity-preview' ? 'Inspecting…' : 'Review credentials needing reauthentication'}</button></div>
          {credentialContinuityPreview && <div className="pilot-continuity" aria-live="polite"><p className="pilot-key-state" role="status">Reauthentication required · values excluded</p>{credentialContinuityPreview.stores.map(store => <p key={store.id} className="pilot-copy">{store.id}: {store.entries.length ? store.entries.map(entry => `${entry.key}${entry.scope === 'user' ? ' (user-scoped)' : ''}${entry.supported ? '' : ' (unsupported)'}`).join(' · ') : 'No recognized credentials'}</p>)}</div>}
        </article>
      </section>
      <footer className="pilot-footer" aria-live="polite"><span className={`pilot-message-dot ${error ? 'is-error' : ''}`} aria-hidden="true" /><span>{error || notice || 'Native host only. Product UI runs in the browser.'}</span></footer>
    </main>
  )
}
