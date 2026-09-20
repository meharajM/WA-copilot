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
    expect(host).toContain('Open agentd data folder')
    expect(host).toContain('Product UI runs in the browser')
    expect(host).toContain('Confirm chat history')
    expect(host).toContain('Apply chat history')
    expect(host).toContain('Refresh chat-history status')
    expect(host).toContain('Rollback chat history')
    expect(host).toContain('Review credentials needing reauthentication')
    expect(host).toContain('values excluded')
    expect(host).toContain('Install sign-in service')
    expect(host).toContain('Remove sign-in service')
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

  it('exposes explicit browser WebGPU mode while keeping remote providers daemon-backed', () => {
    const providers = readSource('components/settings/llm/LLMProviderSettings.tsx')
    expect(providers).toContain("id === 'auto' || id === 'ollama' || id === 'openai' || id === 'gemini' || id === 'openrouter' || id === 'browser'")
    expect(providers).toContain("const showBrowser = p === 'browser'")
    expect(providers).toContain("checkBrowserLLM")
    expect(providers).toContain("<BrowserLLMSettings")
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
    expect(handler).toContain('open_agentd_data_folder')
    expect(handler).toContain('service_status')
    expect(handler).toContain('service_install')
    expect(handler).toContain('service_uninstall')
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
    expect(agent).toContain('...(daemonAttachments?.length ? { attachments: daemonAttachments } : {})')
    expect(storage).toContain('The Tauri native companion does not mount the product workspace')
  })

  it('keeps browser email auto-reply inside the authenticated agentd policy path', () => {
    const agent = readSource('hooks/useAgent.ts')
    const bridge = readSource('hooks/useEmailBridge.ts')
    const mcp = readSource('lib/mcp.ts')
    const electron = readSource('lib/electron.ts')

    expect(agent).toContain('client.saveEmailDraft(draft)')
    expect(agent).toContain('client.sendEmailDraft(saved.id)')
    expect(agent).toContain('emailAlreadyHydrated')
    expect(agent).toContain('if ((isEmailFlow || browserWhatsAppFlow) && options?.skipUserMessage) throw error')
    expect(agent).toContain('const browserEmailSend = async')
    expect(agent).toContain('WebGPU generation is local to the browser, but email policy')
    expect(agent).toContain('if (browserRuntime) {')
    expect(agent).toContain('await applyBrowserEmailPolicy(responseText)')
    expect(mcp).toContain('Browser Email tool calls are disabled')
    expect(mcp).not.toContain('isBrowserProduct()) return await electron.email.send')
    expect(electron).toContain('getBrowserAgentdClient().listEmailAttachments(limit)')
    expect(electron).toContain('getBrowserAgentdClient().retrieveGmailAttachment(messageId, attachmentId, metadata)')
    expect(bridge).toContain('emailGenerationRequestId: `email_${event.id}`')
    expect(bridge).toContain('emailDraftId: `draft_email_${event.id}`')
    expect(bridge).toContain('const durableDrafts = await client.listEmailDrafts()')
    expect(bridge).toContain('alreadyHandled: durableDrafts.some((draft) => draft.id === `draft_email_${event.id}`)')
    expect(bridge).toContain('await client.acknowledgeEmailInbound([event.id])')
    expect(bridge.indexOf('onComplete: completion')).toBeLessThan(bridge.indexOf('acknowledgeEmailInbound'))
  })

  it('keeps browser WhatsApp inbound generation replay-safe and routes autonomous sends through the outbox', () => {
    const agent = readSource('hooks/useAgent.ts')
    const bridge = readSource('hooks/useWhatsAppBridge.ts')
    const client = readSource('lib/browser-agentd-client.ts')
    const resolutionAudit = readSource('hooks/useResolutionAudit.ts')

    expect(agent).toContain('client.createWhatsAppDraft')
    expect(agent).toContain('policyDecision')
    expect(agent).toContain("client.updateDraftStatus(draft.draftId, 'approved')")
    expect(agent).toContain('client.sendWhatsAppDraft(draft.draftId)')
    expect(agent).toContain('60s courtesy notification through the durable WhatsApp outbox')
    expect(agent).toContain("kind: 'admin_escalation'")
    expect(agent).toContain("client.logAccuracy({ event: 'forwarded'")
    expect(agent).toContain('WhatsApp response drafted for review')
    expect(agent).toContain('!browserWhatsAppFlow && !isAdmin && multimodalWhatsAppMessage.type !== \'text\'')
    expect(agent).toContain('if (browserWhatsAppFlow) {')
    expect(agent).toContain('selected provider is the renderer\'s WebGPU model')
    expect(agent).toContain('never fall through to Electron IPC')
    expect(agent).toContain('whatsappAlreadyHydrated')
    expect(bridge).toContain('whatsappGenerationRequestId: `whatsapp_${event.id}`')
    expect(bridge).toContain('whatsappEvent: {')
    expect(bridge).toContain('durableDrafts.some((draft) => draft.providerEventId === event.providerEventId)')
    expect(bridge.indexOf('onComplete: completion')).toBeLessThan(bridge.indexOf('afterId = result.nextAfterId'))
    expect(client).toContain("'/api/v1/whatsapp/events'")
    expect(client).toContain('accepted: boolean')
    expect(resolutionAudit).toContain('Browser/agentd owns inactivity follow-up durably')
    expect(resolutionAudit).toContain('!isElectron() && !isTauriRuntime()')
  })

  it('keeps browser brain corrections on the runtime-aware agentd route', () => {
    const actions = readSource('components/chat/MessageActions.tsx')
    expect(actions).toContain("executeToolCall('rag_save_correction'")
    expect(actions).toContain('if (result.error) throw new Error(result.error)')
    expect(actions).not.toContain("electron.mcp.callTool('internal-rag', 'rag_save_correction'")
  })

  it('does not load browser sign-in secrets through the Electron secure-store bridge', () => {
    const settings = readSource('stores/settingsStore.ts')
    const loader = settings.indexOf('loadUserSecrets: async')
    const browserGuard = settings.indexOf('if (isBrowserProduct()) {', loader)
    const electronSecureRead = settings.indexOf("electron.secure.get('openai_api_key', uid)", loader)

    expect(loader).toBeGreaterThan(-1)
    expect(browserGuard).toBeGreaterThan(loader)
    expect(electronSecureRead).toBeGreaterThan(browserGuard)
    expect(settings.slice(browserGuard, electronSecureRead)).toContain('openaiApiKey:')
    expect(settings.slice(browserGuard, electronSecureRead)).toContain('return')
  })

  it('does not expose Electron-only autonomy controls in the browser workspace', () => {
    const autonomy = readSource('components/AutonomyPanel.tsx')

    expect(autonomy).toContain("!browserRuntime && webState")
    expect(autonomy).toContain("!browserRuntime && <button")
    expect(autonomy).not.toContain("browserRuntime ? electron.whatsapp.web")
  })

  it('presents browser WhatsApp autonomous mode through the durable outbox', () => {
    const settings = readSource('components/SettingsPanel.tsx')
    const bridge = readSource('hooks/useWhatsAppBridge.ts')
    const autonomy = readSource('components/AutonomyPanel.tsx')
    const electronSource = readSource('lib/electron.ts')

    expect(settings).toContain('Autonomous Bot Mode')
    expect(settings).toContain('durable review/outbox path')
    expect(settings).not.toContain('disabled={browserRuntime}')
    expect(bridge).toContain('(!whatsappEnabled && !businessBotMode)')
    expect(bridge).toContain('same durable event cursor')
    expect(autonomy).not.toContain('Auto-reply unavailable')
    expect(autonomy).toContain('WhatsApp auto mode is controlled in Settings')
    expect(electronSource).toContain("mode: whatsappState.businessBotMode ? 'auto'")
    expect(electronSource).toContain('whatsapp.setBusinessBotMode(true)')
  })

  it('keeps browser email credentials transport-scoped and review-only', () => {
    const emailSettings = readSource('components/settings/EmailSettingsPanel.tsx')
    const drafts = readSource('components/email/DraftApprovalPanel.tsx')

    expect(emailSettings).toContain("client.setCredential('email_imap_password', value)")
    expect(emailSettings).toContain("client.setCredential('email_smtp_password', value)")
    expect(readSource('stores/emailStore.ts')).toContain('flushEmailSettingsPersistence')
    expect(readSource('hooks/useEmailBridge.ts')).toContain('await flushEmailSettingsPersistence()')
    expect(emailSettings).toContain('runs authenticated generation and confidence policy')
    expect(drafts).toContain('gated IMAP/Gmail polling')
    expect(drafts).toContain('Safe operator-selected PDF, image, and text attachments')
    expect(drafts).toContain('dispatchBrowserDeliveryStatus')
    expect(drafts).toContain('Email delivered:')
    expect(drafts).not.toContain('IMAP polling, OAuth, attachments, and insecure SMTP remain unavailable.')
  })

  it('keeps generic browser WhatsApp tools on authenticated agentd or explicit fail-closed paths', () => {
    const mcp = readSource('lib/mcp.ts')
    expect(mcp).toContain("if (isBrowserProduct()) {")
    expect(mcp).toContain("getBrowserAgentdClient().sendWhatsAppText(targetJid, content)")
    expect(mcp).toContain('Browser WhatsApp media tools require the authenticated attachment route')
    expect(mcp).toContain('Browser WhatsApp admin escalation is daemon-owned')
  })

  it('routes legacy WhatsApp wrapper calls through authenticated agentd in browsers', () => {
    const electron = readSource('lib/electron.ts')
    expect(electron).toContain('getBrowserAgentdClient().connectWhatsApp(phoneNumber)')
    expect(electron).toContain('getBrowserAgentdClient().setWhatsAppTarget(phoneNumber)')
    expect(electron).toContain('getBrowserAgentdClient().sendWhatsAppText(to, content)')
    expect(electron).toContain('getBrowserAgentdClient().disconnectWhatsApp(clearAuth)')
  })

  it('keeps browser autonomy state live without reviving Electron events', () => {
    const electron = readSource('lib/electron.ts')
    const onState = electron.indexOf('onState: (callback: (state: unknown) => void) => {')
    const onDecision = electron.indexOf('onDecision:', onState)

    expect(onState).toBeGreaterThan(-1)
    expect(onDecision).toBeGreaterThan(onState)
    expect(electron.slice(onState, onDecision)).toContain('browserAutonomyState()')
    expect(electron.slice(onState, onDecision)).toContain('setTimeout')
    expect(electron.slice(onState, onDecision)).toContain('clearTimeout')
    expect(electron.slice(onState, onDecision)).toContain('window.electron?.autonomy')
  })

  it('routes browser owner notifications through authenticated agentd', () => {
    const electron = readSource('lib/electron.ts')
    expect(electron).toContain('getBrowserAgentdClient().listAutonomyNotifications()')
    expect(electron).toContain('getBrowserAgentdClient().ackAutonomyNotification(id)')
  })

  it('derives browser unresolved and sent history from the durable agentd outbox', () => {
    const electron = readSource('lib/electron.ts')
    expect(electron).toContain("draft.sendStatus === 'pending' || draft.sendStatus === 'failed'")
    expect(electron).toContain("draft.sendStatus === 'sent' && draft.providerMessageId")
    expect(electron).toContain("channel: 'whatsapp'")
  })

  it('keeps browser failed outbox rows actionable without changing Electron delivery-unknown controls', () => {
    const autonomy = readSource('components/AutonomyPanel.tsx')
    expect(autonomy).toContain("browserRuntime && item.status === 'failed'")
    expect(autonomy).toContain('electron.autonomy.cancelOutbound(item.inboundId)')
    expect(autonomy).toContain("item.status === 'delivery-unknown'")
  })

  it('routes browser autonomy usage history through authenticated agentd', () => {
    const electron = readSource('lib/electron.ts')
    const client = readSource('lib/browser-agentd-client.ts')
    expect(electron).toContain('getBrowserAgentdClient().getAutonomyUsageHistory(days)')
    expect(electron).toContain('getBrowserAgentdClient().getAutonomyChannelUsage(days)')
    expect(client).toContain('/api/v1/autonomy/usage-history?days=')
    expect(client).toContain('/api/v1/autonomy/channel-usage?days=')
  })

  it('routes browser decision evidence and reviews through authenticated agentd', () => {
    const electron = readSource('lib/electron.ts')
    const client = readSource('lib/browser-agentd-client.ts')
    expect(electron).toContain('getBrowserAgentdClient().listDecisionEvidence(limit)')
    expect(electron).toContain('getBrowserAgentdClient().reviewDecision')
    expect(client).toContain('/api/v1/autonomy/decision-evidence?limit=')
    expect(client).toContain('/review')
  })

  it('routes browser delivery history across WhatsApp and Email through authenticated agentd', () => {
    const electron = readSource('lib/electron.ts')
    const client = readSource('lib/browser-agentd-client.ts')
    expect(electron).toContain('getBrowserAgentdClient().listEmailDeliveryHistory(boundedLimit)')
    expect(electron).toContain('getBrowserAgentdClient().listDrafts(boundedLimit)')
    expect(client).toContain('/api/v1/email/delivery-history?limit=')
  })

  it('routes browser recovery holds through authenticated agentd', () => {
    const electron = readSource('lib/electron.ts')
    const client = readSource('lib/browser-agentd-client.ts')
    expect(electron).toContain('getBrowserAgentdClient().enterRecoveryMode(reason)')
    expect(electron).toContain('getBrowserAgentdClient().clearRecoveryMode()')
    expect(electron).toContain('enterRecoveryMode(reason).then(browserAutonomyState)')
    expect(electron).toContain('clearRecoveryMode().then(browserAutonomyState)')
    expect(client).toContain('/api/v1/autonomy/recovery/enter')
    expect(client).toContain('/api/v1/autonomy/recovery/clear')
  })

  it('routes browser persona reads and writes through agentd', () => {
    const electron = readSource('lib/electron.ts')
    expect(electron).toContain('getBrowserAgentdClient().getPersonaSettings()')
    expect(electron).toContain('getBrowserAgentdClient().savePersonaSettings')
  })

  it('describes browser knowledge as bounded text plus supervised binary conversion', () => {
    const knowledge = readSource('components/chat/KnowledgeBrowser.tsx')

    expect(knowledge).toContain('bounded text and document files')
    expect(knowledge).toContain('convertKnowledge')
    expect(knowledge).toContain('readBrowserKnowledgeBinaryFile')
    expect(knowledge).not.toContain('Binary conversion is not available in the browser yet.')
    expect(knowledge).not.toContain('visual data')
    expect(knowledge).not.toContain('ToIndex documents, spreadsheets or images')
  })

  it('keeps the dashboard training picker on the same browser conversion boundary', () => {
    const dashboard = readSource('components/chat/EmptyState.tsx')

    expect(dashboard).toContain('readBrowserKnowledgeBinaryFile')
    expect(dashboard).toContain('client.convertKnowledge')
    expect(dashboard).toContain('PDF, DOCX, XLSX, PPTX')
    expect(dashboard).not.toContain('browser import supports text, Markdown, CSV, JSON, XML, HTML, and log files')
  })

  it('does not seed browser dashboard topics when there is no analyzed activity', () => {
    const dashboard = readSource('components/chat/EmptyState.tsx')

    expect(dashboard).toContain('if (topicsLog.length === 0) return []')
    expect(dashboard).toContain('No analyzed sessions yet.')
    expect(dashboard).not.toContain('Math.max(metrics.messagesToday, 10)')
  })
})
