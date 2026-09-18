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
    expect(entry).not.toMatch(/workspace\s*=|location\.(search|hash)/)
  })

  it('keeps the native host free of product workspace imports', () => {
    const host = readSource('NativeHostDiagnostics.tsx')

    expect(host).not.toContain("from './App'")
    expect(host).not.toContain("from './BrowserProduct'")
    expect(host).not.toContain('ChatView')
    expect(host).toContain('Native capabilities')
    expect(host).toContain('Open browser workspace')
    expect(host).toContain('Product UI runs in the browser')
    expect(host).toContain('Confirm chat history')
    expect(host).toContain('Apply chat history')
    expect(host).toContain('Refresh chat-history status')
    expect(host).toContain('Rollback chat history')
    expect(host).toContain('Review credentials needing reauthentication')
    expect(host).toContain('values excluded')
    expect(host).not.toContain('confirmationToken}</')
  })

  it('makes BrowserProduct the only entry that lazy-loads App.tsx', () => {
    const browser = readSource('BrowserProduct.tsx')
    expect(browser).toContain("React.lazy(() => import('./App'))")
  })

  it('keeps browser startup daemon-gated and explicit about pairing states', () => {
    const browser = readSource('BrowserProduct.tsx')
    const dependencies = readSource('components/SystemDependenciesSettings.tsx')

    expect(browser).toContain("client.readiness()")
    expect(browser).toContain('Connecting to local agent…')
    expect(browser).toContain('Local service unavailable')
    expect(browser).toContain('Retry connection')
    expect(browser).toContain('Pair this browser')
    expect(browser).toContain('The code is used once and never stored in the browser.')
    expect(browser).toContain("<FullWorkspace />")
    expect(dependencies).toContain('if (browserRuntime) return;')
    expect(dependencies).toContain('Browser mode does not install or inspect host tools.')
  })

  it('keeps on-device provider out of the browser selector while exposing daemon Gemini', () => {
    const providers = readSource('components/settings/llm/LLMProviderSettings.tsx')
    expect(providers).toContain("id === 'auto' || id === 'ollama' || id === 'openai' || id === 'gemini' || id === 'openrouter'")
    expect(providers).toContain("const showGemini = p === 'gemini' || p === 'auto'")
    expect(providers).toContain("client.hasCredential('openai_api_key')")
    expect(providers).toContain("client.hasCredential('openrouter_api_key')")
    expect(providers).toContain("client.testProvider('gemini')")
  })

  it('registers only native capability commands in the Tauri host', () => {
    const native = readNativeSource('main.rs')
    const handler = native.slice(native.indexOf('.invoke_handler('), native.indexOf('.setup('))

    expect(handler).toContain('agentd_health')
    expect(handler).toContain('agentd_pairing_code')
    expect(handler).toContain('credential_set')
    expect(handler).toContain('credential_exists')
    expect(handler).toContain('credential_delete')
    expect(handler).toContain('select_file')
    expect(handler).toContain('select_folder')
    expect(handler).toContain('open_browser_workspace')
    expect(handler).toContain('chat_history_confirm')
    expect(handler).toContain('chat_history_apply')
    expect(handler).toContain('chat_history_status')
    expect(handler).toContain('chat_history_rollback')
    expect(handler).toContain('credential_continuity_preview')
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

  it('keeps browser brain corrections on the runtime-aware agentd route', () => {
    const actions = readSource('components/chat/MessageActions.tsx')
    expect(actions).toContain("executeToolCall('rag_save_correction'")
    expect(actions).toContain('if (result.error) throw new Error(result.error)')
    expect(actions).not.toContain("electron.mcp.callTool('internal-rag', 'rag_save_correction'")
  })

  it('does not expose Electron-only autonomy controls in the browser workspace', () => {
    const autonomy = readSource('components/AutonomyPanel.tsx')

    expect(autonomy).toContain("!browserRuntime && webState")
    expect(autonomy).toContain("!browserRuntime && <button")
    expect(autonomy).not.toContain("browserRuntime ? electron.whatsapp.web")
  })

  it('does not present browser WhatsApp autonomous-send as an available toggle', () => {
    const settings = readSource('components/SettingsPanel.tsx')

    expect(settings).toContain('Autonomous Bot Mode (unavailable)')
    expect(settings).toContain('disabled={browserRuntime}')
    expect(settings).toContain('automatic replies are not migrated yet.')
  })

  it('keeps browser email credentials transport-scoped and review-only', () => {
    const emailSettings = readSource('components/settings/EmailSettingsPanel.tsx')
    const drafts = readSource('components/email/DraftApprovalPanel.tsx')

    expect(emailSettings).toContain("client.setCredential('email_imap_password', value)")
    expect(emailSettings).toContain("client.setCredential('email_smtp_password', value)")
    expect(emailSettings).toContain('does not generate or send automatic replies')
    expect(drafts).toContain('gated text-only IMAP/Gmail polling')
    expect(drafts).not.toContain('IMAP polling, OAuth, attachments, and insecure SMTP remain unavailable.')
  })

  it('describes browser knowledge as bounded text instead of binary or visual ingestion', () => {
    const knowledge = readSource('components/chat/KnowledgeBrowser.tsx')

    expect(knowledge).toContain('bounded text files')
    expect(knowledge).toContain('Binary conversion is not available in the browser yet.')
    expect(knowledge).not.toContain('visual data')
    expect(knowledge).not.toContain('ToIndex documents, spreadsheets or images')
  })

  it('does not seed browser dashboard topics when there is no analyzed activity', () => {
    const dashboard = readSource('components/chat/EmptyState.tsx')

    expect(dashboard).toContain('if (topicsLog.length === 0) return []')
    expect(dashboard).toContain('No analyzed sessions yet.')
    expect(dashboard).not.toContain('Math.max(metrics.messagesToday, 10)')
  })
})
