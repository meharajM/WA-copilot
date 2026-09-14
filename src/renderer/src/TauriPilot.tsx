import { useEffect, useState } from 'react'
import { credentialKeys, type CredentialKey, type NativeHealth } from '../../shared/native-bridge'
import { tauriNativeBridge } from './lib/tauri-native-bridge'

const readableKey = (key: CredentialKey): string => key.replaceAll('_', ' ')

const messageFrom = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
)

export default function TauriPilot() {
  const [version, setVersion] = useState('loading')
  const [health, setHealth] = useState<NativeHealth>({ status: 'unavailable', error: 'Checking agentd…' })
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [credentialKey, setCredentialKey] = useState<CredentialKey>('openai_api_key')
  const [credentialValue, setCredentialValue] = useState('')
  const [credentialExists, setCredentialExists] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void tauriNativeBridge.appVersion().then((value) => {
      if (!disposed) setVersion(value)
    }).catch((reason) => {
      if (!disposed) {
        setVersion('unavailable')
        setError(messageFrom(reason, 'App version unavailable'))
      }
    })
    void tauriNativeBridge.health().then((value) => {
      if (!disposed) setHealth(value)
    })
    const unsubscribe = tauriNativeBridge.onAgentdHealth((value) => {
      if (!disposed) setHealth(value)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const runPicker = async (kind: 'file' | 'folder') => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      const path = kind === 'file'
        ? await tauriNativeBridge.selectFile({ title: 'Choose a pilot file' })
        : await tauriNativeBridge.selectFolder()
      if (path) {
        setSelectedPath(path)
        setNotice(`${kind === 'file' ? 'File' : 'Folder'} selected`)
      } else {
        setNotice('Selection canceled')
      }
    } catch (reason) {
      setError(messageFrom(reason, `${kind} picker unavailable`))
    } finally {
      setBusy(null)
    }
  }

  const setCredential = async () => {
    const value = credentialValue
    setCredentialValue('')
    setBusy('set-credential')
    setError(null)
    setNotice(null)
    try {
      const result = await tauriNativeBridge.setCredential(credentialKey, value)
      if (!result.success) throw new Error(result.error || 'Credential set failed')
      setCredentialExists(true)
      setNotice(`${readableKey(credentialKey)} saved to native keychain`)
    } catch (reason) {
      setError(messageFrom(reason, 'Credential set failed'))
    } finally {
      setBusy(null)
    }
  }

  const checkCredential = async () => {
    setBusy('check-credential')
    setError(null)
    setNotice(null)
    try {
      const result = await tauriNativeBridge.hasCredential(credentialKey)
      if (!result.success) throw new Error(result.error || 'Credential check failed')
      setCredentialExists(result.exists)
      setNotice(result.exists ? 'Credential is present' : 'Credential is not set')
    } catch (reason) {
      setCredentialExists(null)
      setError(messageFrom(reason, 'Credential check failed'))
    } finally {
      setBusy(null)
    }
  }

  const deleteCredential = async () => {
    setBusy('delete-credential')
    setError(null)
    setNotice(null)
    try {
      const result = await tauriNativeBridge.deleteCredential(credentialKey)
      if (!result.success) throw new Error(result.error || 'Credential delete failed')
      setCredentialExists(false)
      setNotice(`${readableKey(credentialKey)} removed from native keychain`)
    } catch (reason) {
      setError(messageFrom(reason, 'Credential delete failed'))
    } finally {
      setBusy(null)
    }
  }

  const healthy = health.status === 'ready'

  return (
    <main className="pilot-shell">
      <header className="pilot-header">
        <div>
          <p className="pilot-kicker">AICA / native boundary</p>
          <h1>Tauri pilot</h1>
          <p className="pilot-lede">A quiet proving ground for the host-owned runtime.</p>
        </div>
        <div className="pilot-runtime-badge">
          <span className="pilot-dot pilot-dot-live" aria-hidden="true" />
          <span>TAURI</span>
          <span className="pilot-slash">/</span>
          <span>v{version}</span>
        </div>
      </header>

      <section className="pilot-grid" aria-label="Native runtime pilot controls">
        <article className={`pilot-panel pilot-health ${healthy ? 'is-ready' : 'is-unavailable'}`}>
          <div className="pilot-panel-heading">
            <div>
              <p className="pilot-label">01 / runtime signal</p>
              <h2>agentd health</h2>
            </div>
            <span className="pilot-status" role="status">
              <span className="pilot-dot" aria-hidden="true" />
              {healthy ? 'Ready' : 'Unavailable'}
            </span>
          </div>
          <div className="pilot-health-readout">
            <span className="pilot-health-line" aria-hidden="true" />
            <div>
              <strong>{healthy ? 'Worker connected' : 'Worker needs attention'}</strong>
              <p>{health.error || 'Health events will appear here as the sidecar changes state.'}</p>
            </div>
          </div>
          <dl className="pilot-facts">
            <div><dt>runtime</dt><dd>tauri / rust host</dd></div>
            <div><dt>worker</dt><dd>{health.version || 'protocol v1'}</dd></div>
          </dl>
        </article>

        <article className="pilot-panel">
          <div className="pilot-panel-heading">
            <div>
              <p className="pilot-label">02 / native dialogs</p>
              <h2>Choose a path</h2>
            </div>
            <span className="pilot-index">FILE · FOLDER</span>
          </div>
          <p className="pilot-copy">Selections stay in the native host. The pilot only receives the chosen path.</p>
          <div className="pilot-actions">
            <button type="button" className="pilot-button pilot-button-primary" onClick={() => void runPicker('file')} disabled={busy !== null}>
              {busy === 'file' ? 'Opening…' : 'Choose file'}
            </button>
            <button type="button" className="pilot-button" onClick={() => void runPicker('folder')} disabled={busy !== null}>
              {busy === 'folder' ? 'Opening…' : 'Choose folder'}
            </button>
          </div>
          <p className="pilot-path" aria-live="polite">{selectedPath || 'No path selected yet'}</p>
        </article>

        <article className="pilot-panel pilot-credentials">
          <div className="pilot-panel-heading">
            <div>
              <p className="pilot-label">03 / keychain boundary</p>
              <h2>Credential lifecycle</h2>
            </div>
            <span className={`pilot-key-state ${credentialExists === true ? 'is-set' : ''}`}>
              {credentialExists === true ? 'STORED' : credentialExists === false ? 'EMPTY' : 'UNKNOWN'}
            </span>
          </div>
          <p className="pilot-copy">Write-only controls. Values leave this field on submit and never return to the UI.</p>
          <div className="pilot-form-row">
            <label htmlFor="credential-key">Key</label>
            <select id="credential-key" value={credentialKey} onChange={(event) => {
              setCredentialKey(event.target.value as CredentialKey)
              setCredentialExists(null)
            }} disabled={busy !== null}>
              {credentialKeys.map((key) => <option value={key} key={key}>{readableKey(key)}</option>)}
            </select>
          </div>
          <div className="pilot-form-row">
            <label htmlFor="credential-value">Value</label>
            <input id="credential-value" type="password" autoComplete="off" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} placeholder="Paste once; cleared on submit" disabled={busy !== null} />
          </div>
          <div className="pilot-actions pilot-actions-tight">
            <button type="button" className="pilot-button pilot-button-primary" onClick={() => void setCredential()} disabled={busy !== null || !credentialValue}>
              {busy === 'set-credential' ? 'Saving…' : 'Set value'}
            </button>
            <button type="button" className="pilot-button" onClick={() => void checkCredential()} disabled={busy !== null}>
              {busy === 'check-credential' ? 'Checking…' : 'Check exists'}
            </button>
            <button type="button" className="pilot-button pilot-button-danger" onClick={() => void deleteCredential()} disabled={busy !== null}>
              {busy === 'delete-credential' ? 'Removing…' : 'Delete'}
            </button>
          </div>
        </article>
      </section>

      <footer className="pilot-footer" aria-live="polite">
        <span className={`pilot-message-dot ${error ? 'is-error' : ''}`} aria-hidden="true" />
        <span>{error || notice || 'Pilot scope: runtime, sidecar health, native dialogs, and keychain lifecycle.'}</span>
      </footer>
    </main>
  )
}
