import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('MCP defaults contracts', () => {
  it('keeps baseline MCP servers configured in defaults', async () => {
    const source = await fs.readFile(
      path.resolve(process.cwd(), 'src/renderer/src/stores/mcpStore.ts'),
      'utf8'
    )

    const requiredServerNames = ['playwright', 'memory', 'filesystem', 'rag', 'markitdown']
    for (const name of requiredServerNames) {
      expect(source).toContain(`name: '${name}'`)
    }

    expect(source).toContain("command: 'internal'")
    expect(source).toContain("command: 'internal-memory'")
    expect(source).toContain("command: 'internal-filesystem'")
    expect(source).toContain("command: 'internal-rag'")
    expect(source).toContain("command: 'uvx'")
    expect(source).toContain("args: ['markitdown-mcp[all]']")
    expect(source).toContain('autoConnect: true')
  })

  it('retains migration path for markitdown full extras and lazy auto-connect behavior', async () => {
    const source = await fs.readFile(
      path.resolve(process.cwd(), 'src/renderer/src/stores/mcpStore.ts'),
      'utf8'
    )

    expect(source).toContain("updated.name === 'markitdown'")
    expect(source).toContain("updated.args = ['markitdown-mcp[all]']")
    expect(source).toContain('const autoConnectServers = initialServers.filter')
    expect(source).toContain('s.autoConnect && s.tools.length === 0')
  })
})

