import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sourceRoot = resolve(process.cwd(), 'src/renderer/src')
const readSource = (relativePath: string) => readFileSync(resolve(sourceRoot, relativePath), 'utf8')

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
})
