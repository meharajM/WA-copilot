import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')
const readRenderer = (relativePath: string) => readFileSync(resolve(rendererRoot, relativePath), 'utf8')

describe('browser command palette parity contract', () => {
  it('keeps the product palette mounted in the shared App used by browser and Electron clients', () => {
    const app = readRenderer('App.tsx')

    expect(app).toContain("import { CommandPalette } from \"./components/CommandPalette\"")
    expect(app).toContain('<CommandPalette onViewChange={setCurrentView} />')
  })

  it('preserves the documented keyboard lifecycle and command actions', () => {
    const palette = readRenderer('components/CommandPalette.tsx')

    expect(palette).toContain("e.key === 'k' && (e.metaKey || e.ctrlKey)")
    expect(palette).toContain("const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'")
    expect(palette).toContain("if (e.key === 'Escape') setOpen(false)")
    expect(palette).toContain('<span>Clear Chat</span>')
    expect(palette).toContain('<span>Toggle Sidebar</span>')
    expect(palette).toContain('<span>MCP Connections</span>')
    expect(palette).toContain('<span>Settings</span>')
    expect(palette).toContain('<span>Connect WhatsApp</span>')
    expect(palette).toContain('<span>Enable WhatsApp Mode</span>')
    expect(palette).toContain('<span>Disable WhatsApp Mode</span>')
    expect(palette).toContain("onViewChange?.('connections')")
    expect(palette).toContain("onViewChange?.('settings')")
    expect(palette).toContain('clearMessages()')
    expect(palette).toContain('toggleSidebar()')
    expect(palette).toContain('openDialog()')
    expect(palette).toContain('setWhatsAppEnabled(true)')
    expect(palette).toContain('setWhatsAppEnabled(false)')
  })

  it('does not make the browser palette depend on Electron or Tauri-only APIs', () => {
    const palette = readRenderer('components/CommandPalette.tsx')

    expect(palette).not.toMatch(/electron|tauri/i)
  })
})
