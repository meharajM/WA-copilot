import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  const filePath = path.resolve(process.cwd(), relativePath)
  return fs.readFile(filePath, 'utf8')
}

function expectAll(source: string, tokens: string[], scope: string): void {
  for (const token of tokens) {
    expect(source, `${scope} is missing token: ${token}`).toContain(token)
  }
}

describe('feature surface regression contracts', () => {
  it('App keeps core view routing and startup hooks wired', async () => {
    const appSource = await readSource('src/renderer/src/App.tsx')

    expectAll(
      appSource,
      [
        "case 'dashboard'",
        "case 'chat'",
        "case 'brain'",
        "case 'leads'",
        "case 'settings'",
        "case 'connections'",
        "case 'identity'",
        'useSettingsSync();',
        'useThemeSync();',
        'useAuthPersistence();',
        'useWhatsAppBridge();',
        'useResolutionAudit();',
      ],
      'App view/hook wiring'
    )
  })

  it('Sidebar keeps navigation paths for dashboard, conversations, leads, and settings', async () => {
    const sidebarSource = await readSource('src/renderer/src/components/Sidebar.tsx')
    const footerSource = await readSource('src/renderer/src/components/sidebar/SidebarFooter.tsx')

    expectAll(
      sidebarSource,
      [
        'Command Center',
        'All Chats',
        'Brain View',
        'Lead Directory',
        "onViewChange('dashboard')",
        "onViewChange('chat')",
        "onViewChange('brain')",
        "onViewChange('leads')",
      ],
      'Sidebar primary navigation'
    )

    expectAll(
      footerSource,
      [
        'Conversations',
        'MCP Connections',
        'Settings',
        "onViewChange('chat')",
        "onViewChange('connections')",
        "onViewChange('settings')",
      ],
      'Sidebar footer navigation'
    )
  })

  it('Dashboard keeps analytics/reporting blocks and refresh controls', async () => {
    const dashboardSource = await readSource('src/renderer/src/components/chat/EmptyState.tsx')

    expectAll(
      dashboardSource,
      [
        'AIConsumerAgent Dashboard',
        'Daily Msgs',
        'Active Leads',
        'Data Points',
        'Autonomy',
        'Conversation Topics',
        'Sync Insights',
        'Generate Daily Report',
        'Open Reports',
        'handleGenerateDailyReport',
        'handleOpenReportsFolder',
        'electron.reports.generateDaily',
        'electron.reports.openFolder',
      ],
      'Dashboard analytics/reporting surface'
    )
  })

  it('Conversation view keeps chat controls and progress feedback wired', async () => {
    const chatViewSource = await readSource('src/renderer/src/components/chat/ChatView.tsx')
    const chatInputSource = await readSource('src/renderer/src/components/input/ChatInput.tsx')

    expectAll(
      chatViewSource,
      [
        'Resolve Conversation',
        'Clear Chat',
        'TypingIndicator',
        'ProgressBanner',
        'JumpToBottom',
      ],
      'Conversation display surface'
    )

    expectAll(
      chatInputSource,
      [
        'VoiceButton',
        'AttachmentBar',
        'InputToolbar',
        'SendButton',
        'WhatsAppToggle',
      ],
      'Conversation input surface'
    )
  })

  it('Lead generation and knowledge management screens keep core actions', async () => {
    const leadsSource = await readSource('src/renderer/src/components/chat/LeadDirectory.tsx')
    const knowledgeSource = await readSource('src/renderer/src/components/chat/KnowledgeBrowser.tsx')

    expectAll(
      leadsSource,
      [
        'Lead Directory',
        'Search leads by name or number',
        'setActiveSession',
        'Auto-extracted Lead',
      ],
      'Lead directory surface'
    )

    expectAll(
      knowledgeSource,
      [
        'Knowledge Brain',
        'Add Knowledge',
        'Search indexed documents',
        'handleDelete',
        'handleAddKnowledge',
      ],
      'Knowledge browser surface'
    )
  })

  it('Settings panel keeps all major section entries', async () => {
    const settingsSource = await readSource('src/renderer/src/components/SettingsPanel.tsx')

    expectAll(
      settingsSource,
      [
        'WhatsApp Business',
        'Business Tools (MCP)',
        'Bot Identity',
        'Account',
        'AI Model Connection',
        'Knowledge Base',
        'Web Automation',
        'Appearance',
        'Audit Logs',
        'System Info',
      ],
      'Settings section registry'
    )
  })
})
