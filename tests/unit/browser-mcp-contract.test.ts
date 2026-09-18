import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }), { virtual: true })

import { useMcpStore } from '../../src/renderer/src/stores/mcpStore'

const root = new URL('../..', import.meta.url)
const source = (path: string) => readFile(new URL(path, root), 'utf8')

describe('browser MCP contract', () => {
  beforeEach(() => {
    window.electron = undefined
    ;(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined
    useMcpStore.setState({ servers: [], initialized: false, activeUserId: null })
    window.localStorage.clear()
  })

  it('guards renderer MCP storage and actions in browser mode', async () => {
    const store = await source('src/renderer/src/stores/mcpStore.ts')
    const panel = await source('src/renderer/src/components/SettingsPanel.tsx')

    expect(store).toContain('export function isBrowserMcpUnavailable()')
    expect(store).toContain('if (isBrowserMcpUnavailable()) return')
    expect(store).not.toContain('const legacy = await electron.store.get<MCPServer[]>(storageKey)')
    expect(store).toContain('getBrowserAgentdClient().getMcpServers()')
    expect(panel).toContain('Arbitrary MCP server management and tool execution are unavailable in the browser')
    expect(panel).toContain('!isBrowserMcpUnavailable()')
  })

  it('keeps Electron MCP delegation unchanged and browser calls fail closed', async () => {
    const electron = await source('src/renderer/src/lib/electron.ts')
    const store = await source('src/renderer/src/stores/mcpStore.ts')

    expect(electron).toContain('return await window.electron.mcp.connect(serverConfig)')
    expect(electron).toContain('return await window.electron.mcp.callTool(serverId, toolName, args, requestId)')
    expect(electron).toContain('MCP server management is not available in browser mode')
    expect(electron).toContain('MCP tool execution is not available in browser mode')
    expect(store).toContain('await electron.store.get<MCPServer[]>(storageKey)')
    expect(store).toContain('await electron.mcp.connect({')
  })

  it('loads sanitized agentd definitions with GET only and keeps browser actions inert', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBeUndefined()
      return new Response(JSON.stringify({
        servers: [{ id: 'safe', name: 'Safe', description: 'Read-only', type: 'stdio', execution: 'unavailable', autoConnect: false }],
        execution: 'unavailable', reason: 'execution unavailable',
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const setItem = vi.spyOn(window.localStorage, 'setItem')

    await useMcpStore.getState().initialize()
    expect(useMcpStore.getState().servers).toMatchObject([{
      id: 'safe', name: 'Safe', connected: false, tools: [], autoConnect: false,
      error: 'MCP execution is unavailable in browser mode',
    }])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/v1/mcp/servers')
    expect(setItem).not.toHaveBeenCalled()

    await useMcpStore.getState().addServer({ name: 'new', description: '', type: 'stdio', command: 'bash', args: [] })
    await useMcpStore.getState().updateServer('safe', { name: 'changed' })
    await useMcpStore.getState().removeServer('safe')
    await useMcpStore.getState().connectServer('safe')
    await useMcpStore.getState().disconnectServer('safe')
    await useMcpStore.getState().setAutoConnect('safe', true)
    await useMcpStore.getState().syncServers([{ name: 'remote' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(useMcpStore.getState().servers[0].name).toBe('Safe')
  })
})
