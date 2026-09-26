import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const root = new URL('../..', import.meta.url)
const source = (path: string) => readFile(new URL(path, root), 'utf8')

describe('native bridge security boundary', () => {
  it('defines a credential-write-only native bridge contract', async () => {
    const bridge = await source('src/shared/native-bridge.ts')

    expect(bridge).toContain("export type NativeRuntime = 'electron' | 'tauri' | 'browser'")
    expect(bridge).toContain('export type CredentialKey =')
    expect(bridge).toContain('export interface NativeBridge')
    expect(bridge).toContain('setCredential')
    expect(bridge).toContain('hasCredential')
    expect(bridge).toContain('deleteCredential')
    expect(bridge).not.toContain('getCredential')
  })

  it('fails closed for browser secure storage while keeping Electron delegation', async () => {
    const electron = await source('src/renderer/src/lib/electron.ts')
    const secure = electron.slice(electron.indexOf('    secure: {'), electron.indexOf('    // FS operations'))

    expect(secure).not.toContain('localStorage')
    expect(secure).not.toContain('secure_')
    expect(secure).toContain('return await window.electron.secure.set(key, value, userId)')
    expect(secure).toContain('return await window.electron.secure.get(key, userId)')
    expect(secure).toContain('return await window.electron.secure.delete(key, userId)')
    expect(secure.match(/success: true/g)).toBeNull()
    expect(secure).toContain("Not supported in browser mode")
  })

  it('does not persist legacy Electron store calls in browser localStorage', async () => {
    const electron = await source('src/renderer/src/lib/electron.ts')
    const store = electron.slice(electron.indexOf('    store: {'), electron.indexOf('    // Secure storage'))

    expect(store).not.toContain('localStorage')
    expect(store).toContain('if (isBrowserProduct()) return defaultValue')
    expect(store).toContain("Browser product storage is owned by authenticated agentd")
    expect(store).toContain('const value = await window.electron.store.get(key)')
    expect(store).toContain('return await window.electron.store.set(key, value)')
    expect(store).toContain('return await window.electron.store.delete(key)')
  })

  it('gets the browser version from authenticated agentd instead of a stale renderer constant', async () => {
    const electron = await source('src/renderer/src/lib/electron.ts')
    const app = electron.slice(electron.indexOf('    app: {'), electron.indexOf('    // MCP operations'))

    expect(app).toContain('getBrowserAgentdClient().getSystemInfo()')
    expect(app).toContain('productVersion')
    expect(app).toContain("return '0.1.0'")
  })

  it('does not return success-shaped MCP browser mocks', async () => {
    const electron = await source('src/renderer/src/lib/electron.ts')
    const mcp = electron.slice(electron.indexOf('    // MCP operations'), electron.indexOf('    // Electron-only storage.'))

    expect(mcp).not.toContain('mock_')
    expect(mcp).not.toContain('MCP connect mock')
    expect(mcp).toContain('MCP server management is not available in browser mode')
    expect(mcp).toContain('MCP tool execution is not available in browser mode')
  })
})
