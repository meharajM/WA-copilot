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
})
