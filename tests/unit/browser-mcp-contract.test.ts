import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const source = (path: string) => readFile(new URL(path, root), 'utf8')

describe('browser MCP contract', () => {
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
})
