import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd(), 'browser-extension')

describe('browser extension pilot contract', () => {
  it('keeps permissions limited to storage, WhatsApp Web and loopback', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { permissions: string[]; host_permissions: string[]; background: { service_worker: string }; content_scripts: Array<{ matches: string[]; js: string[] }> }
    expect(manifest.permissions).toEqual(['storage'])
    expect(manifest.host_permissions).toEqual(['https://web.whatsapp.com/*', 'http://127.0.0.1:8790/*'])
    expect(manifest.background).toEqual({ service_worker: 'background.js' })
    expect(manifest.content_scripts).toEqual([{ matches: ['https://web.whatsapp.com/*'], js: ['content.js'], run_at: 'document_idle' }])
  })

  it('contains no outbound or arbitrary page-evaluation API', () => {
    const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8')
    expect(source).not.toMatch(/chrome\.tabs|chrome\.scripting|executeScript|fetch\(/)
    expect(source).toContain('chrome.runtime.sendMessage')
    expect(source).toContain('response.accepted !== true')
    expect(source).toContain('setInterval(scan, 5_000)')
    expect(source).toContain('inFlight')
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8')
    expect(background).toContain("bridgeUrl('/messages'")
    expect(background).toContain('127.0.0.1:8790')
    expect(background).not.toContain('settings.port')
    expect(background).toContain('response.status === 202')
    expect(background).toContain('sendResponse({ accepted: false })')
    expect(background).toContain('sendResponse(result)')
  })
})
