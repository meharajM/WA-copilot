import React, { FormEvent, Suspense, useEffect, useState } from 'react'
import { getBrowserAgentdClient } from './lib/browser-agentd-client'

const client = getBrowserAgentdClient()
const FullWorkspace = React.lazy(() => import('./App'))

const messageFrom = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
)

export default function BrowserProduct() {
  const [state, setState] = useState<'loading' | 'ready' | 'pairing' | 'unavailable'>('loading')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setState(await client.readiness())
  }

  useEffect(() => { void refresh() }, [])

  const pair = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await client.pair(code)
      setCode('')
      setState('ready')
    } catch (reason) {
      setError(messageFrom(reason, 'Pairing failed'))
      setState('pairing')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'ready') return <Suspense fallback={<main className="pilot-shell"><p>Loading workspace…</p></main>}><FullWorkspace /></Suspense>
  if (state === 'loading') return <main className="pilot-shell"><p>Connecting to local agent…</p></main>

  if (state === 'unavailable') {
    return (
      <main className="pilot-shell">
        <header className="pilot-header">
          <div><p className="pilot-kicker">AICA / BROWSER WORKSPACE</p><h1>Local service unavailable</h1><p className="pilot-lede">Start the AICA native companion, then refresh this page. Product UI stays in your browser.</p></div>
        </header>
        <section className="pilot-panel">
          <button type="button" className="pilot-button pilot-button-primary" onClick={() => void refresh()}>Retry connection</button>
        </section>
      </main>
    )
  }

  return (
    <main className="pilot-shell">
      <header className="pilot-header">
        <div><p className="pilot-kicker">AICA / BROWSER WORKSPACE</p><h1>Pair this browser</h1><p className="pilot-lede">Enter the six-digit code shown by the local native companion. The code is used once and never stored in the browser.</p></div>
      </header>
      <section className="pilot-panel">
        <form onSubmit={pair} className="pilot-form">
          <label htmlFor="agentd-pairing-code">Pairing code</label>
          <input id="agentd-pairing-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" required />
          <button type="submit" className="pilot-button pilot-button-primary" disabled={busy || code.length !== 6}>{busy ? 'Pairing…' : 'Pair browser'}</button>
        </form>
        <p className="pilot-health-readout" role="status">{error || 'Pairing creates an HttpOnly local session. Credential values stay in the native OS store.'}</p>
      </section>
    </main>
  )
}
