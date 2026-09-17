import { describe, expect, it, vi } from 'vitest'
import { createBrowserAgentdClient } from '../../src/renderer/src/lib/browser-agentd-client'

const response = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('browser agentd client', () => {
  it('pairs with HttpOnly session cookies and sends CSRF only for mutations', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/healthz')) return response({ ok: true })
      if (url.endsWith('/api/v1/status')) {
        return calls.some(call => call.url.endsWith('/api/v1/pair')) ? response({ runtime: 'agentd', paused: false, queueDepth: 0, events: 0 }) : response({ error: 'Authentication required' }, 401)
      }
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 }, 200, { 'set-cookie': 'agentd_session=opaque; HttpOnly' })
      if (url.endsWith('/api/v1/session')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/sessions')) return response({ sessions: [] })
      throw new Error(`unexpected request ${url}`)
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })

    await expect(client.readiness()).resolves.toBe('pairing')
    await client.pair('123456')
    await expect(client.readiness()).resolves.toBe('ready')
    await client.loadSessions()

    const pairCall = calls.find(call => call.url.endsWith('/api/v1/pair'))!
    expect(pairCall.init?.credentials).toBe('include')
    expect(pairCall.init?.body).toBe(JSON.stringify({ code: '123456' }))
    const statusCall = calls.find(call => call.url.endsWith('/api/v1/status'))!
    expect(new Headers(statusCall.init?.headers).has('x-csrf-token')).toBe(false)
    const sessionsCall = calls.find(call => call.url.endsWith('/api/v1/sessions'))!
    expect(new Headers(sessionsCall.init?.headers).has('x-csrf-token')).toBe(false)

    // A browser reload loses the in-memory token but keeps the HttpOnly cookie.
    // The authenticated session bootstrap restores mutation protection.
    const reloadedClient = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await expect(reloadedClient.readiness()).resolves.toBe('ready')
    await reloadedClient.createSession('chat_after_reload', 'Reloaded')
    const reloadMutation = calls.find(call => call.url.endsWith('/api/v1/sessions') && call.init?.method === 'POST' && String(call.init?.body).includes('chat_after_reload'))!
    expect(new Headers(reloadMutation.init?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('maps chat routes and emits complete-response events without renderer storage', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/sessions')) return response({ sessions: [{ id: 'chat_1', title: 'Saved', createdAt: 10, updatedAt: 20 }] })
      if (url.endsWith('/api/v1/sessions/chat_1')) return response({ session: { id: 'chat_1', title: 'Saved', createdAt: 10, updatedAt: 20 }, messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: 15 }] })
      if (url.endsWith('/generations')) return response({ generation: { sessionId: 'chat_1', requestId: 'r1', streaming: false }, message: { id: 'assistant_r1', role: 'assistant', content: 'answer', createdAt: 30 } })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.loadSessions()).resolves.toMatchObject([{ id: 'chat_1', messages: [{ id: 'm1' }] }])
    await client.createSession('chat_2', 'New')
    await client.createSession('chat_3', 'Workspace', 'browser://workspace/Support')
    await client.updateSessionWorkspace('chat_3', null)
    await client.appendMessage('chat_1', { id: 'm2', role: 'user', content: 'next', timestamp: 40 })
    const events: string[] = []
    await client.generate({ sessionId: 'chat_1', requestId: 'r1', content: 'hello' }, event => events.push(event.type))
    expect(events).toEqual(['assistant.delta', 'assistant.done'])
    const mutation = calls.find(call => call.url.endsWith('/api/v1/sessions') && call.init?.method === 'POST')!
    expect(new Headers(mutation.init?.headers).get('x-csrf-token')).toBe('csrf-token')
    expect(calls.some(call => call.url.endsWith('/api/v1/sessions/chat_3') && call.init?.method === 'PATCH')).toBe(true)
    expect(JSON.stringify(calls).includes('agentd_session')).toBe(false)
  })

  it('rejects malformed origins and pairing codes before network access', async () => {
    const fetcher = vi.fn()
    expect(() => createBrowserAgentdClient({ origin: 'https://user:pass@example.test/path', fetch: fetcher })).toThrow('Invalid agentd origin')
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await expect(client.pair('12')).rejects.toThrow('Pairing code must be six digits')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps authenticated persona settings without using renderer secret storage', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/settings/persona')) return response({ name: 'AICA', industry: 'Support', tone: 'professional', coreKnowledge: [] })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getPersonaSettings()).resolves.toMatchObject({ name: 'AICA', tone: 'professional' })
    await expect(client.savePersonaSettings({ name: 'AICA', industry: 'Support', tone: 'concise', coreKnowledge: ['FAQ'] })).resolves.toMatchObject({ tone: 'professional' })
    const mutation = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/settings/persona') && init?.method === 'PUT')
    expect(new Headers(mutation?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('maps durable product preferences and audit logs through agentd', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/settings/preferences')) return response({
        theme: 'dark', playwrightBrowser: 'auto', playwrightHeadless: false, fileSystemSafeMode: true,
        memoryBackend: 'sqlite', ttsEnabled: true, ttsRate: 1, ttsPitch: 1, ttsVoice: null,
        speechLang: 'en-US', offlineSpeech: false, voskModel: 'en-us', browserModel: 'tiny',
      })
      if (url.includes('/api/v1/logs?')) return response({ entries: [{ timestamp: '2026-01-01T00:00:00.000Z', eventType: 'DEBUG' }] })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getProductPreferences()).resolves.toMatchObject({ theme: 'dark', memoryBackend: 'sqlite' })
    await expect(client.saveProductPreferences({
      theme: 'light', playwrightBrowser: 'msedge', playwrightHeadless: true, fileSystemSafeMode: true,
      memoryBackend: 'sqlite', ttsEnabled: true, ttsRate: 1, ttsPitch: 1, ttsVoice: null,
      speechLang: 'en-US', offlineSpeech: false, voskModel: 'en-us', browserModel: 'tiny',
    })).resolves.toMatchObject({ theme: 'dark' })
    await client.appendAuditLog({ eventType: 'DEBUG', details: { value: 'x' } })
    await expect(client.listAuditLogs()).resolves.toMatchObject([{ eventType: 'DEBUG' }])
    const put = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/settings/preferences') && init?.method === 'PUT')
    expect(new Headers(put?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
    const post = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/logs') && init?.method === 'POST')
    expect(new Headers(post?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('maps draft-only autonomy controls to authenticated agentd routes', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/status')) return response({ runtime: 'agentd', paused: true, queueDepth: 2, events: 1 })
      if (url.endsWith('/api/v1/pause-all')) return response({ paused: true, actor: 'browser' })
      if (url.endsWith('/api/v1/resume-all')) return response({ paused: false, actor: 'browser' })
      if (url.includes('/api/v1/drafts?')) return response({ drafts: [{ id: 7, channel: 'whatsapp', providerEventId: 'evt-7', conversationId: 'customer-7', responseText: 'draft reply', status: 'draft', createdAt: 10, updatedAt: 20 }] })
      if (url.endsWith('/api/v1/drafts/7')) return response({ id: 7, channel: 'whatsapp', providerEventId: 'evt-7', conversationId: 'customer-7', responseText: 'draft reply', status: 'approved', createdAt: 10, updatedAt: 30 })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.status()).resolves.toMatchObject({ paused: true, queueDepth: 2 })
    await expect(client.resumeAll()).resolves.toEqual({ paused: false })
    await expect(client.listDrafts()).resolves.toMatchObject([{ providerEventId: 'evt-7', status: 'draft' }])
    await expect(client.updateDraftStatus(7, 'approved')).resolves.toMatchObject({ id: 7, status: 'approved' })
    const mutation = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/drafts/7') && init?.method === 'PATCH')
    expect(new Headers(mutation?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('maps browser knowledge and intelligence routes without Electron fallbacks', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.includes('/api/v1/knowledge/search')) return response({ results: [{ id: 1, file_path: 'browser://knowledge/faq.md', file_name: 'faq.md', created_at: '2026-01-01T00:00:00.000Z', content: 'refunds are allowed', rank: -1 }] })
      if (url.endsWith('/api/v1/knowledge') && init?.method === 'POST') return response({ success: true, document: { id: 2, file_path: 'browser://knowledge/new.md', file_name: 'new.md', created_at: '2026-01-01T00:00:00.000Z' } })
      if (url.includes('/api/v1/knowledge?')) return response({ documents: [{ id: 1, file_path: 'browser://knowledge/faq.md', file_name: 'faq.md', file_type: 'text/markdown', size: 20, created_at: '2026-01-01T00:00:00.000Z' }] })
      if (url.endsWith('/api/v1/intelligence/stats')) return response({ success: true, stats: { totalQueries: 2, resolvedQueries: 1, autonomyRate: 50, trainingCount: 1, learningCount: 0 } })
      if (url.includes('/api/v1/intelligence/logs?')) return response({ logs: [{ id: 1, type: 'accuracy', event: 'resolved', timestamp: '2026-01-01T00:00:00.000Z' }] })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.listKnowledge()).resolves.toMatchObject([{ file_name: 'faq.md' }])
    await expect(client.searchKnowledge('refunds')).resolves.toMatchObject([{ content: 'refunds are allowed' }])
    await expect(client.ingestKnowledge({ fileName: 'new.md', filePath: 'browser://knowledge/new.md', fileType: 'text/markdown', content: 'new', size: 3 })).resolves.toMatchObject({ file_name: 'new.md' })
    await expect(client.getIntelligenceStats()).resolves.toMatchObject({ resolvedQueries: 1 })
    await expect(client.listIntelligenceLogs()).resolves.toMatchObject([{ event: 'resolved' }])
    await client.logAccuracy({ event: 'resolved', details: 'verified' })
    const ingest = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/knowledge') && init?.method === 'POST')
    expect(new Headers(ingest?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })
})
