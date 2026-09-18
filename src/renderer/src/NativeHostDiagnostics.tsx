import { useEffect, useState } from 'react'
import type { CredentialKey, NativeHealth } from '../../shared/native-bridge'
import { tauriNativeBridge, type NativeContinuityPreview } from './lib/tauri-native-bridge'

const CREDENTIALS: Array<{ key: CredentialKey; label: string }> = [
  { key: 'openai_api_key', label: 'OpenAI key' },
  { key: 'openrouter_api_key', label: 'OpenRouter key' },
]

const messageFrom = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
)

export default function NativeHostDiagnostics() {
  const [version, setVersion] = useState('loading')
  const [agentdOrigin, setAgentdOrigin] = useState<string | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [health, setHealth] = useState<NativeHealth>({ status: 'unavailable', error: 'Checking agentd…' })
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [credential, setCredential] = useState<CredentialKey>('openai_api_key')
  const [credentialState, setCredentialState] = useState<'unknown' | 'present' | 'missing'>('unknown')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [continuityPreview, setContinuityPreview] = useState<NativeContinuityPreview | null>(null)
  const [migrationId, setMigrationId] = useState<string | null>(null)

  const refresh = async () => {
    try { setHealth(await tauriNativeBridge.health()) }
    catch (reason) { setHealth({ status: 'unavailable', error: messageFrom(reason, 'Native host unavailable') }) }
  }

  useEffect(() => {
    void tauriNativeBridge.appVersion().then(setVersion).catch(() => setVersion('unavailable'))
    void tauriNativeBridge.agentdOrigin().then((origin) => setAgentdOrigin(`${origin}/tauri.html`)).catch(() => setAgentdOrigin(null))
    void refresh()
  }, [])

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
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void openBrowserWorkspace()} disabled={busy !== null || !agentdOrigin}>{busy === 'browser' ? 'Opening…' : 'Open browser workspace'}</button><button type="button" className="pilot-button" onClick={() => void revealPairingCode()} disabled={busy !== null || !agentdOrigin}>{busy === 'pairing' ? 'Reading…' : pairingCode ? 'Refresh pairing code' : 'Show pairing code'}</button><button type="button" className="pilot-button" onClick={() => void refresh()} disabled={busy !== null}>Refresh status</button></div>
          {pairingCode && <p className="pilot-pairing-code" aria-live="polite"><span>Browser pairing code</span><strong>{pairingCode}</strong></p>}
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">02 / file access</p><h2>Owner-selected paths</h2></div><span className="pilot-index">OS PICKER</span></div>
          <p className="pilot-copy">Choose a path for an owner-approved native workflow. Product uploads use the browser picker; arbitrary filesystem access is not exposed.</p>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void choose('file')} disabled={busy !== null}>{busy === 'file' ? 'Opening…' : 'Choose file'}</button><button type="button" className="pilot-button" onClick={() => void choose('folder')} disabled={busy !== null}>{busy === 'folder' ? 'Opening…' : 'Choose folder'}</button></div>
          <p className="pilot-path" aria-live="polite">{selectedPath || 'No path selected yet'}</p>
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">03 / credential store</p><h2>Presence only</h2></div><span className="pilot-index">OS STORE</span></div>
          <p className="pilot-copy">Check whether a provider credential exists. Values never enter this window.</p>
          <div className="pilot-form-row"><label htmlFor="native-credential">Credential</label><select id="native-credential" value={credential} onChange={(event) => { setCredential(event.target.value as CredentialKey); setCredentialState('unknown') }} disabled={busy !== null}>{CREDENTIALS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void checkCredential()} disabled={busy !== null}>{busy === 'credential' ? 'Checking…' : 'Check presence'}</button><span className="pilot-key-state" role="status">{credentialState === 'present' ? 'Stored' : credentialState === 'missing' ? 'Not stored' : 'Not checked'}</span></div>
        </article>
        <article className="pilot-panel">
          <div className="pilot-panel-heading"><div><p className="pilot-label">04 / continuity</p><h2>Stage Electron data</h2></div><span className="pilot-index">OWNER ACTION</span></div>
          <p className="pilot-copy">Preview and stage only allowlisted, non-secret stores. This does not replace live agentd data; credentials require separate reauthentication.</p>
          <div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void previewContinuity()} disabled={busy !== null}>{busy === 'continuity-preview' ? 'Validating…' : 'Preview Electron data'}</button></div>
          {continuityPreview && <div className="pilot-continuity" aria-live="polite"><p>{continuityPreview.entries.map(entry => `${entry.id} (${entry.byteSize} bytes)`).join(' · ')}</p><p className="pilot-copy">Review this list before staging. Credential and live-database cutover remain separate reauthentication-gated work.</p><div className="pilot-actions"><button type="button" className="pilot-button pilot-button-primary" onClick={() => void stageContinuity()} disabled={busy !== null || Boolean(migrationId)}>{busy === 'continuity-import' ? 'Staging…' : 'Stage validated data'}</button>{migrationId && <button type="button" className="pilot-button" onClick={() => void rollbackContinuity()} disabled={busy !== null}>{busy === 'continuity-rollback' ? 'Rolling back…' : 'Rollback staging'}</button>}</div></div>}
        </article>
      </section>
      <footer className="pilot-footer" aria-live="polite"><span className={`pilot-message-dot ${error ? 'is-error' : ''}`} aria-hidden="true" /><span>{error || notice || 'Native host only. Product UI runs in the browser.'}</span></footer>
    </main>
  )
}
