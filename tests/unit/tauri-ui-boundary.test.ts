import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(process.cwd(), 'src/renderer/src')
const readSource = (relativePath: string) => readFileSync(resolve(sourceRoot, relativePath), 'utf8')
const readNativeSource = (relativePath: string) => readFileSync(resolve(process.cwd(), 'src-tauri/src', relativePath), 'utf8')

describe('browser-first UI boundary', () => {
  it('routes browser loads to the product workspace and Tauri loads to native diagnostics only', () => {
    const entry = readSource('tauri-main.tsx')

    expect(entry).toContain("import NativeHostDiagnostics from './NativeHostDiagnostics'")
    expect(entry).toContain("import BrowserProduct from './BrowserProduct'")
    expect(entry).toContain('{isTauriRuntime() ? <NativeHostDiagnostics /> : <BrowserProduct />}')
    expect(entry).not.toContain('TauriChatPreview')
  })

  it('keeps the native host free of product workspace imports', () => {
    const host = readSource('NativeHostDiagnostics.tsx')

    expect(host).not.toContain("from './App'")
    expect(host).not.toContain("from './BrowserProduct'")
    expect(host).not.toContain('ChatView')
    expect(host).toContain('Native capabilities')
    expect(host).toContain('Open browser workspace')
    expect(host).toContain('Product UI runs in the browser')
  })

  it('makes BrowserProduct the only entry that lazy-loads App.tsx', () => {
    const browser = readSource('BrowserProduct.tsx')
    expect(browser).toContain("React.lazy(() => import('./App'))")
  })

  it('registers only native capability commands in the Tauri host', () => {
    const native = readNativeSource('main.rs')
    const handler = native.slice(native.indexOf('.invoke_handler('), native.indexOf('.setup('))

    expect(handler).toContain('agentd_health')
    expect(handler).toContain('credential_set')
    expect(handler).toContain('credential_exists')
    expect(handler).toContain('credential_delete')
    expect(handler).toContain('select_file')
    expect(handler).toContain('select_folder')
    expect(handler).toContain('open_browser_workspace')
    expect(handler).not.toMatch(/get_llm_settings|save_llm_settings|get_whatsapp_settings|save_whatsapp_settings|provider_test|chat_generate|chat_load_sessions|chat_create_session|chat_append_message/)
  })

  it('does not route product hooks through a Tauri chat client', () => {
    const agent = readSource('hooks/useAgent.ts')
    const storage = readSource('stores/chatStore.ts')

    expect(agent).not.toContain('createTauriChatClient')
    expect(agent).not.toContain('isTauriRuntime() ?')
    expect(agent).toContain('!isTauriRuntime()')
    expect(storage).toContain('The Tauri native companion does not mount the product workspace')
  })
})
