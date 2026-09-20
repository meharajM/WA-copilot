import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }), { virtual: true })

import { useMcpStore } from '../../src/renderer/src/stores/mcpStore'

const root = new URL('../..', import.meta.url)
const source = (path: string) => readFile(new URL(path, root), 'utf8')

const lifecycle = {
  runtime: 'agentd',
  management: 'available',
  execution: 'available',
  reason: 'Approved MCP servers run under the supervised agentd worker',
  transports: ['stdio', 'sse', 'http'],
  tools: ['connect', 'disconnect', 'listTools', 'callTool', 'cancel'],
}

const server = {
  id: 'safe',
  name: 'Safe',
  description: 'Read-only',
  type: 'stdio' as const,
  command: 'uvx',
  args: ['markitdown-mcp[all]'],
  allowedTools: ['convert_to_markdown'],
  envKeys: ['OPENAI_API_KEY'],
  execution: 'available' as const,
  connected: false,
  tools: [],
  autoConnect: false,
}

let activeFetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => new Response('{}', { status: 500 })

describe('browser MCP contract', () => {
  beforeEach(() => {
    window.electron = undefined
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined
    useMcpStore.setState({ servers: [], initialized: false, activeUserId: null, browserMcpLifecycle: null })
    window.localStorage.clear()
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => activeFetcher(input, init))
  })

  it('uses the authenticated agentd worker while preserving the Electron adapter', async () => {
    const store = await source('src/renderer/src/stores/mcpStore.ts')
    const panel = await source('src/renderer/src/components/SettingsPanel.tsx')
    const client = await source('src/renderer/src/lib/browser-agentd-client.ts')

    expect(store).toContain('client.getMcpServers()')
    expect(store).toContain('getBrowserAgentdClient().saveMcpServers')
    expect(store).toContain('connectMcpServer')
    expect(client).toContain('callMcpTool')
    expect(client).toContain('cancelMcpTool')
    expect(panel).toContain('supervised local agentd worker')
    expect(panel).toContain('!browserMcpUnavailable')
  })

  it('loads agentd definitions without renderer storage or secret values', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/mcp')) return new Response(JSON.stringify(lifecycle), { status: 200 })
      if (url.endsWith('/api/v1/mcp/servers')) return new Response(JSON.stringify({ servers: [{ ...server, env: { OPENAI_API_KEY: 'secret' } }], execution: 'available', reason: lifecycle.reason }), { status: 200 })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    activeFetcher = fetcher
    const setItem = vi.spyOn(window.localStorage, 'setItem')

    await useMcpStore.getState().initialize()
    expect(useMcpStore.getState().browserMcpLifecycle).toMatchObject({ execution: 'available' })
    expect(useMcpStore.getState().servers).toMatchObject([{ id: 'safe', command: 'uvx', connected: false, tools: [], autoConnect: false }])
    expect(useMcpStore.getState().servers[0]).not.toHaveProperty('env')
    expect(setItem).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('routes browser mutations through agentd with CSRF and updates runtime state', async () => {
    const connected = { ...server, connected: true, tools: [{ name: 'convert_to_markdown', description: 'Convert', inputSchema: {} }] }
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/mcp')) return new Response(JSON.stringify(lifecycle), { status: 200 })
      if (url.endsWith('/api/v1/mcp/servers') && init?.method === undefined) return new Response(JSON.stringify({ servers: [server], execution: 'available', reason: lifecycle.reason }), { status: 200 })
      if (url.endsWith('/api/v1/mcp/servers') && init?.method === 'PUT') return new Response(JSON.stringify({ servers: [server], execution: 'available', reason: lifecycle.reason }), { status: 200 })
      if (url.endsWith('/safe/connect')) return new Response(JSON.stringify({ server: connected }), { status: 200 })
      if (url.endsWith('/safe/disconnect')) return new Response(JSON.stringify({ server }), { status: 200 })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    activeFetcher = fetcher
    ;(window as Window & { __AICA_AGENTD_CSRF_TOKEN__?: string }).__AICA_AGENTD_CSRF_TOKEN__ = 'csrf-token'
    await useMcpStore.getState().initialize()

    await useMcpStore.getState().updateServer('safe', { name: 'Renamed' })
    await useMcpStore.getState().connectServer('safe')
    expect(useMcpStore.getState().servers[0]).toMatchObject({ connected: true, tools: [{ name: 'convert_to_markdown' }] })
    await useMcpStore.getState().disconnectServer('safe')
    await useMcpStore.getState().setAutoConnect('safe', true)
    await useMcpStore.getState().removeServer('safe')

    const mutationCalls = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT' || init?.method === 'POST')
    expect(mutationCalls.length).toBeGreaterThanOrEqual(5)
    expect(mutationCalls.every(([, init]) => new Headers(init?.headers).get('x-csrf-token') === 'csrf-token')).toBe(true)
  })
})
