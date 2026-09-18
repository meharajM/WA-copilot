import { describe, expect, it, vi } from 'vitest'
import { createBrowserAgentdClient, readBrowserKnowledgeFile } from '../../src/renderer/src/lib/browser-agentd-client'

const response = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('browser agentd client', () => {
  it('bounds browser knowledge files before upload', async () => {
    const file = (content: string, size = content.length) => ({
      name: 'notes.md', type: 'text/markdown', size, text: async () => content,
    }) as unknown as File

    await expect(readBrowserKnowledgeFile(file('hello'))).resolves.toEqual({ content: 'hello', size: 5, fileType: 'text/markdown' })
    await expect(readBrowserKnowledgeFile(file('x', 16 * 1024 * 1024 + 1))).rejects.toThrow('16 MB or smaller')
    await expect(readBrowserKnowledgeFile(file('🙂'.repeat(200_000)))).rejects.toThrow('512 KiB or smaller')
  })

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
      if (url.endsWith('/api/v1/sessions')) return response({ sessions: [{ id: 'chat_1', title: 'Saved', createdAt: 10, updatedAt: 20, status: 'resolved', channel: 'email', contactId: 'alice@example.com', threadId: 'thread-1' }] })
      if (url.endsWith('/api/v1/sessions/chat_1')) return response({ session: { id: 'chat_1', title: 'Saved', createdAt: 10, updatedAt: 20, status: 'resolved', channel: 'email', contactId: 'alice@example.com', threadId: 'thread-1' }, messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: 15 }] })
      if (url.endsWith('/generations')) return response({ generation: { sessionId: 'chat_1', requestId: 'r1', streaming: false }, message: { id: 'assistant_r1', role: 'assistant', content: 'answer', createdAt: 30 } })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.loadSessions()).resolves.toMatchObject([{ id: 'chat_1', status: 'resolved', channel: 'email', contact_id: 'alice@example.com', thread_id: 'thread-1', messages: [{ id: 'm1' }] }])
    await client.createSession('chat_2', 'New')
    await client.createSession('chat_3', 'Workspace', 'browser://workspace/Support')
    await client.createSession('chat_4', 'Customer email', undefined, { status: 'resolved', channel: 'email', contactId: 'alice@example.com', threadId: 'thread-1', topic: 'Product Queries' })
    await client.updateSessionWorkspace('chat_3', null, { status: 'resolved', channel: 'email', contactId: 'bob@example.com', threadId: 'thread-2', topic: 'Technical Support' })
    await client.appendMessage('chat_1', { id: 'm2', role: 'user', content: 'next', timestamp: 40 })
    const events: string[] = []
    await client.generate({ sessionId: 'chat_1', requestId: 'r1', content: 'hello' }, event => events.push(event.type))
    expect(events).toEqual(['assistant.delta', 'assistant.done'])
    const mutation = calls.find(call => call.url.endsWith('/api/v1/sessions') && call.init?.method === 'POST')!
    expect(new Headers(mutation.init?.headers).get('x-csrf-token')).toBe('csrf-token')
    const metadataMutation = calls.find(call => call.url.endsWith('/api/v1/sessions') && call.init?.method === 'POST' && String(call.init?.body).includes('alice@example.com'))!
    expect(JSON.parse(String(metadataMutation.init?.body))).toMatchObject({ status: 'resolved', channel: 'email', contactId: 'alice@example.com', threadId: 'thread-1', topic: 'Product Queries' })
    expect(calls.some(call => call.url.endsWith('/api/v1/sessions/chat_3') && call.init?.method === 'PATCH')).toBe(true)
    const metadataUpdate = calls.find(call => call.url.endsWith('/api/v1/sessions/chat_3') && call.init?.method === 'PATCH')!
    expect(JSON.parse(String(metadataUpdate.init?.body))).toMatchObject({ workspacePath: null, status: 'resolved', channel: 'email', contactId: 'bob@example.com', threadId: 'thread-2', topic: 'Technical Support' })
    expect(JSON.stringify(calls).includes('agentd_session')).toBe(false)
  })

  it('consumes browser SSE deltas and sends authenticated cancellation on abort', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/sessions/chat_stream/generations')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
            controller.enqueue(encoder.encode('data: {"type":"assistant.delta","sessionId":"chat_stream","requestId":"r-stream","sequence":1,"delta":"hello"}\n\n'))
            init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.endsWith('/api/v1/sessions/chat_stream/generations/r-stream/cancel')) return response({ cancelled: true })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    const events: string[] = []
    const controller = new AbortController()
    const generation = client.generate({ sessionId: 'chat_stream', requestId: 'r-stream', content: 'hello' }, event => events.push(event.type), controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(generation).rejects.toMatchObject({ name: 'AbortError' })
    expect(streamController).toBeDefined()
    expect(events).toEqual(['assistant.delta'])
    const cancel = calls.find(call => call.url.endsWith('/generations/r-stream/cancel'))
    expect(cancel).toBeDefined()
    expect(new Headers(cancel?.init?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('rejects malformed origins and pairing codes before network access', async () => {
    const fetcher = vi.fn()
    expect(() => createBrowserAgentdClient({ origin: 'https://user:pass@example.test/path', fetch: fetcher })).toThrow('Invalid agentd origin')
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await expect(client.pair('12')).rejects.toThrow('Pairing code must be six digits')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps continuity readiness without exposing credential values', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/continuity/status')) return response({
        version: 1,
        runtime: 'agentd',
        migration: {
          source: 'electron', target: 'agentd', state: 'native-owner-action-required', secretsExcluded: true,
          note: 'Electron stores require an explicit owner-approved native migration; this read-only endpoint never reads or imports them.',
        },
        stores: [
          { id: 'electron-settings', source: 'electron', target: 'settings.json', format: 'json', schemaVersion: 'electron.settings.v1', requiresReauthentication: true, state: 'pending' },
          { id: 'agentd-state', source: 'agentd', target: 'agentd.db', format: 'sqlite', schemaVersion: 'agentd.v1', requiresReauthentication: true, state: 'active' },
        ],
        data: { sessions: 2, messages: 3, knowledgeDocuments: 0, inboundEvents: 1, drafts: 0 },
        credentials: [{ key: 'openai_api_key', present: true, available: true }],
      })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getContinuityStatus()).resolves.toMatchObject({
      migration: { state: 'native-owner-action-required', secretsExcluded: true },
      data: { sessions: 2, messages: 3 },
      credentials: [{ key: 'openai_api_key', present: true }],
    })
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

  it('validates authenticated system info for browser About labels', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/system-info')) return response({
        productName: 'AIConsumerAgent', productVersion: '1.0.1', runtime: 'agentd', platform: 'Windows', engine: 'Node.js 22.12.0',
      })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getSystemInfo()).resolves.toEqual({
      productName: 'AIConsumerAgent', productVersion: '1.0.1', runtime: 'agentd', platform: 'Windows', engine: 'Node.js 22.12.0',
    })
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith('/api/v1/system-info'))).toBe(true)
  })

  it('maps non-secret email settings through authenticated agentd routes', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/settings/email')) return response({
        accountName: 'support', provider: 'imap-smtp', gmailAuthMode: 'app-password',
        imapHost: 'imap.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 587,
        emailAddress: 'support@example.test', userName: 'support@example.test', imapTls: true, smtpTls: true,
        pollingIntervalSeconds: 60, enabled: false, autoReplyMode: false, draftMode: true,
      })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getEmailSettings()).resolves.toMatchObject({ provider: 'imap-smtp', draftMode: true })
    await client.saveEmailSettings({
      accountName: 'support', provider: 'imap-smtp', gmailAuthMode: 'app-password', imapHost: 'imap.example.test', imapPort: 993,
      smtpHost: 'smtp.example.test', smtpPort: 587, emailAddress: 'support@example.test', userName: 'support@example.test',
      imapTls: true, smtpTls: true, pollingIntervalSeconds: 120, enabled: true, autoReplyMode: false, draftMode: true,
    })
    const put = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/settings/email') && init?.method === 'PUT')
    expect(new Headers(put?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(String(put?.[1]?.body)), 'password')).toBe(false)
  })

  it('persists browser email drafts through authenticated agentd routes', async () => {
    const draft = {
      id: 'draft_email_1', responseText: 'Reply', originalFrom: 'customer@example.test', originalSubject: 'Question', replyTo: 'customer@example.test',
      policyDecision: { action: 'draft' as const, confidence: 0.5, rationale: 'Review', hasSensitiveTopic: false, sensitiveTopics: [] },
      createdAt: 10, status: 'pending_review' as const,
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.includes('/api/v1/email/drafts?')) return response({ drafts: [draft] })
      if (url.endsWith('/api/v1/email/drafts')) return response(draft)
      if (url.endsWith('/api/v1/email/drafts/draft_email_1') && init?.method === 'PATCH') return response({ ...draft, status: 'approved' })
      if (url.endsWith('/api/v1/email/drafts/draft_email_1') && init?.method === 'DELETE') return response({ success: true })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.listEmailDrafts()).resolves.toMatchObject([{ id: draft.id, status: 'pending_review' }])
    await expect(client.saveEmailDraft(draft)).resolves.toMatchObject({ id: draft.id })
    await expect(client.updateEmailDraft(draft.id, { status: 'approved' })).resolves.toMatchObject({ status: 'approved' })
    await client.deleteEmailDraft(draft.id)
    const mutation = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/email/drafts/draft_email_1') && init?.method === 'PATCH')
    expect(new Headers(mutation?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
    expect(JSON.stringify(fetcher.mock.calls).includes('agentd_session')).toBe(false)
  })

  it('lists bounded WhatsApp inbound events through the authenticated cursor', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.includes('/api/v1/whatsapp/inbound?')) return response({
        events: [{ id: 4, providerEventId: 'wa-4', conversationId: '15551234567', payload: { from: '15551234567', text: 'hello' }, status: 'draft', createdAt: 42 }],
        nextAfterId: 4,
      })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.listWhatsAppInbound(0, 10)).resolves.toMatchObject({
      nextAfterId: 4,
      events: [{ providerEventId: 'wa-4', conversationId: '15551234567', payload: { text: 'hello' } }],
    })
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/api/v1/whatsapp/inbound?after_id=0&limit=10'))).toBe(true)
  })

  it('maps browser email transport probe without sending a password', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/email/test')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({})
        expect(String(init?.body).includes('password')).toBe(false)
        return response({ success: true, credentialConfigured: true, transport: { imap: { reachable: true, tls: true }, smtp: { reachable: true, tls: true } } })
      }
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.testEmail()).resolves.toEqual({
      success: true,
      credentialConfigured: true,
      transport: { imap: { reachable: true, tls: true }, smtp: { reachable: true, tls: true } },
    })
    const probe = fetcher.mock.calls.find(([input]) => String(input).endsWith('/api/v1/email/test'))
    expect(new Headers(probe?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('sends explicit browser WhatsApp text through the authenticated Cloud route', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/whatsapp/messages')) return response({ success: true, providerMessageId: 'wamid.123' })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.sendWhatsAppText('+1 (415) 555-1212', 'hello')).resolves.toEqual({ providerMessageId: 'wamid.123' })
    const send = calls.find(call => call.url.endsWith('/api/v1/whatsapp/messages'))!
    expect(JSON.parse(String(send.init?.body))).toEqual({ to: '+1 (415) 555-1212', text: 'hello' })
    expect(new Headers(send.init?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('sends an approved browser WhatsApp draft through the authenticated outbox route', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/whatsapp/drafts/7/send')) return response({ success: true, duplicate: false, providerMessageId: 'wamid.draft-1', draft: { id: 7, channel: 'whatsapp', providerEventId: 'evt-7', conversationId: '14155551212@s.whatsapp.net', responseText: 'draft reply', status: 'sent', createdAt: 10, updatedAt: 30, sendStatus: 'sent', providerMessageId: 'wamid.draft-1', sendAttempts: 1 } })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.sendWhatsAppDraft(7)).resolves.toMatchObject({ providerMessageId: 'wamid.draft-1', duplicate: false, draft: { status: 'sent' } })
    const send = calls.find(call => call.url.endsWith('/api/v1/whatsapp/drafts/7/send'))!
    expect(new Headers(send.init?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('maps browser outbox retry and operator disposition routes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      const draft = { id: 7, channel: 'whatsapp', providerEventId: 'evt-7', conversationId: '14155551212@s.whatsapp.net', responseText: 'draft reply', status: 'approved', createdAt: 10, updatedAt: 30, sendStatus: 'failed', sendAttempts: 2 }
      if (url.endsWith('/retry')) return response({ success: true, duplicate: false, providerMessageId: 'wamid.retry-1', draft: { ...draft, status: 'sent', sendStatus: 'sent', providerMessageId: 'wamid.retry-1' } })
      if (url.endsWith('/quarantine')) return response({ ...draft, sendError: 'Quarantined by operator' })
      if (url.endsWith('/cancel')) return response({ ...draft, sendError: 'Cancelled by operator' })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.retryWhatsAppDraft(7)).resolves.toMatchObject({ providerMessageId: 'wamid.retry-1', draft: { status: 'sent' } })
    await expect(client.quarantineWhatsAppDraft(7)).resolves.toMatchObject({ sendError: 'Quarantined by operator' })
    await expect(client.cancelWhatsAppDraft(7)).resolves.toMatchObject({ sendError: 'Cancelled by operator' })
    for (const suffix of ['/retry', '/quarantine', '/cancel']) {
      const call = calls.find(item => item.url.endsWith(`/api/v1/whatsapp/drafts/7${suffix}`))!
      expect(new Headers(call.init?.headers).get('x-csrf-token')).toBe('csrf-token')
    }
  })

  it('maps loopback Ollama settings and model discovery through agentd', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/settings/ollama')) return response({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' })
      if (url.endsWith('/api/v1/providers/ollama/test')) return response({ success: true, modelCount: 1, models: ['qwen2.5:3b'] })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getOllamaSettings()).resolves.toEqual({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' })
    await expect(client.testOllama()).resolves.toEqual({ success: true, modelCount: 1, models: ['qwen2.5:3b'] })
    await client.saveOllamaSettings({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' })
    const put = calls.find(call => call.url.endsWith('/api/v1/settings/ollama') && call.init?.method === 'PUT')!
    expect(new Headers(put.init?.headers).get('x-csrf-token')).toBe('csrf-token')
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

  it('reads durable browser autonomy metrics from agentd', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.includes('/api/v1/autonomy/metrics')) return response({ inbound: 2, sent: 1, escalated: 0, drafts: 1, failed: 0, averageDecisionLatencyMs: 0, llmCalls: 3, averageLlmLatencyMs: 0, groundedDecisionRate: 0, deliveryUnknown: 0, draftApprovalRate: 0.5, averageDraftEditingTimeMs: 0, estimatedCostPerResolvedConversation: 0, reviewedDecisions: 0, reviewAccuracy: 0, escalationPrecision: 0, unnecessaryEscalations: 0, missedEscalations: 0, recoveryDrills: 0, averageRecoveryTimeMs: 0 })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getAutonomyMetrics(14)).resolves.toMatchObject({ inbound: 2, sent: 1, drafts: 1, llmCalls: 3 })
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

  it('maps durable memory stats, export, and tool calls through agentd', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/memory/stats')) return response({ success: true, stats: { entityCount: 2, relationCount: 1, storageSize: 2048, avgSearchLatency: 0, backend: 'agentd-sqlite' } })
      if (url.endsWith('/api/v1/memory/export')) return response({ success: true, data: { entities: [{ id: 'e1' }], relations: [], metadata: { backend: 'agentd-sqlite' } } })
      if (url.endsWith('/api/v1/memory/tools')) return response({ success: true, result: [{ id: 'e1', name: 'Northwind' }] })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getMemoryStats()).resolves.toMatchObject({ entityCount: 2, backend: 'agentd-sqlite' })
    await expect(client.exportMemory()).resolves.toMatchObject({ entities: [{ id: 'e1' }] })
    await expect(client.callMemoryTool('memory_search', { query: 'Northwind' })).resolves.toMatchObject({ success: true, result: [{ name: 'Northwind' }] })
    const toolCall = fetcher.mock.calls.find(([input]) => String(input).endsWith('/api/v1/memory/tools'))
    expect(new Headers(toolCall?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })

  it('reads authenticated MCP lifecycle metadata', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/mcp')) return response({
        runtime: 'agentd', management: 'unavailable', execution: 'unavailable',
        reason: 'Arbitrary MCP server management and tool execution are not migrated to agentd',
        transports: [], tools: [],
      })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getMcpLifecycle()).resolves.toMatchObject({ runtime: 'agentd', execution: 'unavailable' })
  })

  it('persists browser MCP configuration without env values', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/pair')) return response({ csrfToken: 'csrf-token', expiresAt: Date.now() + 60_000 })
      if (url.endsWith('/api/v1/mcp/servers') && init?.method === 'PUT') return response({
        servers: [{ id: 'mcp_local', name: 'Local', description: '', type: 'stdio', command: 'node', args: ['server.mjs'], autoConnect: false, envKeys: ['API_TOKEN'] }],
        execution: 'unavailable', reason: 'execution unavailable',
      })
      if (url.endsWith('/api/v1/mcp/servers')) return response({
        servers: [{ id: 'mcp_local', name: 'Local', description: '', type: 'stdio', command: 'node', args: ['server.mjs'], autoConnect: false, envKeys: ['API_TOKEN'] }],
        execution: 'unavailable', reason: 'execution unavailable',
      })
      return response({ success: true })
    })
    const client = createBrowserAgentdClient({ origin: 'http://127.0.0.1:4141', fetch: fetcher })
    await client.pair('123456')
    await expect(client.getMcpServers()).resolves.toMatchObject({ servers: [{ id: 'mcp_local', envKeys: ['API_TOKEN'] }] })
    await client.saveMcpServers([{ id: 'mcp_local', name: 'Local', description: '', type: 'stdio', command: 'node', args: ['server.mjs'], autoConnect: false, envKeys: ['API_TOKEN'] }])
    const save = fetcher.mock.calls.find(([input, init]) => String(input).endsWith('/api/v1/mcp/servers') && init?.method === 'PUT')
    expect(new Headers(save?.[1]?.headers).get('x-csrf-token')).toBe('csrf-token')
  })
})
