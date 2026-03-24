import React, { useState, useEffect } from 'react'
import {
    Palette,
    Info,
    Cpu,
    Globe,
    FileText,
    HardDrive,
    MessageCircle,
    Database,
    Plus,
    ArrowLeft,
    FolderOpen,
    Sparkles,
    Activity,
    Zap,
    Clock,
    Trash2,
    Search
} from 'lucide-react'
import { useLogStore } from '../stores/logStore'
import { useSettingsStore, Theme } from '../stores/settingsStore'
import { useWhatsAppStore } from '../stores/whatsappStore'
import { useMcpStore } from '../stores/mcpStore'
import { APP_INFO } from '../lib/constants'
import { MemoryPreferencesPanel } from './settings/MemoryPreferencesPanel'
import { ErrorBoundary } from './ErrorBoundary'
import { LLMProviderSettings } from './settings/llm/LLMProviderSettings'
import { SidebarHeader } from './sidebar/SidebarHeader'
import { McpServerCard } from './mcp/McpServerCard'
import { McpServerForm } from './mcp/McpServerForm'
import { useChatStore } from '../stores/chatStore'
import { Card } from './primitives/Card'
import { StatusBadge } from './primitives/StatusDot'
import { SystemDependenciesSettings } from './SystemDependenciesSettings'

type SettingsSection = 'whatsapp' | 'tools' | 'llm' | 'memory' | 'browser' | 'appearance' | 'logs' | 'about'

interface SettingsPanelProps {
    onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
    const [activeSection, setActiveSection] = useState<SettingsSection>('whatsapp')
    
    // WhatsApp State
    const { connectionState, openDialog, whatsappEnabled, setWhatsAppEnabled, businessBotMode, setBusinessBotMode } = useWhatsAppStore()
    const waStatus = connectionState.status

    // MCP Tools State
    const mcp = useMcpStore()
    const [showMcpForm, setShowMcpForm] = useState(false)
    const [editingMcpId, setEditingMcpId] = useState<string | null>(null)
    const [expandedMcp, setExpandedMcp] = useState<string | null>(null)
    const [connectingMcp, setConnectingMcp] = useState<string | null>(null)

    const settings = useSettingsStore()
    const { openLogFolder, getLogPath } = useLogStore()
    const [logPath, setLogPath] = useState<string>('')

    useEffect(() => {
        getLogPath().then(setLogPath)
    }, [getLogPath])


    const sections: { id: SettingsSection | 'whatsapp' | 'tools'; label: string; icon: React.ReactNode }[] = [
        { id: 'whatsapp', label: 'WhatsApp Business', icon: <MessageCircle size={20} /> },
        { id: 'tools', label: 'Business Tools (MCP)', icon: <Database size={20} /> },
        { id: 'llm', label: 'AI Model Connection', icon: <Cpu size={20} /> },
        { id: 'memory', label: 'Knowledge Base', icon: <HardDrive size={20} /> },
        { id: 'browser', label: 'Web Automation', icon: <Globe size={20} /> },
        { id: 'appearance', label: 'Appearance', icon: <Palette size={20} /> },
        { id: 'logs', label: 'Audit Logs', icon: <FileText size={20} /> },
        { id: 'about', label: 'System Info', icon: <Info size={20} /> },
    ]

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Sidebar styling matched exactly to Co-Worker Hub */}
            <div className="w-64 flex-shrink-0 bg-[var(--color-card-dark)] flex flex-col h-full border-r border-[var(--color-border)] transition-all duration-300">
                <SidebarHeader />

                <div className="flex-1 overflow-y-auto px-5 py-4">
                    <h3 className="text-[10px] font-[var(--font-weight-bold)] text-[var(--color-text-dim)] tracking-wider uppercase mb-3">
                        Settings
                    </h3>
                    <nav className="flex flex-col gap-1">
                        {sections.map((section) => (
                            <button
                                key={section.id}
                                onClick={() => setActiveSection(section.id)}
                                className={`w-full flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg text-xs font-medium transition-colors ${activeSection === section.id
                                    ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)]'
                                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]'
                                    }`}
                            >
                                <span className={activeSection === section.id ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-dim)]'}>
                                    {section.icon}
                                </span>
                                {section.label}
                            </button>
                        ))}
                    </nav>
                </div>

                <div className="px-5 py-4 border-t border-[var(--color-border)]">
                    <button
                        onClick={onClose}
                        title="Chat"
                        className="w-full flex items-center justify-between py-2 px-2 -mx-2 rounded-lg transition-colors group cursor-pointer text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text-primary)]"
                    >
                        <div className="flex items-center gap-3">
                            <ArrowLeft size={16} className="text-[var(--color-text-dim)] group-hover:text-[var(--color-text-primary)]" />
                            <span className="text-xs font-medium">Back to Hub</span>
                        </div>
                    </button>
                </div>
            </div>

            {/* Content pane with darker background for contrast with the Settings panel elements */}
            <div className="flex-1 min-w-0 overflow-y-auto p-10 bg-[var(--color-bg-dark)]">
                {/* WhatsApp Section */}
                {activeSection === 'whatsapp' && (
                    <div className="space-y-6">
                        <h3 className="text-xl font-bold mb-6 text-[var(--color-text-primary)]">WhatsApp Business Configuration</h3>
                        
                        <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl p-6">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-4">
                                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                                        waStatus === 'connected' ? 'bg-[#25D366]/20' : 'bg-[var(--color-surface)]'
                                    }`}>
                                        <MessageCircle size={24} className={waStatus === 'connected' ? 'text-[#25D366]' : 'text-[var(--color-text-dim)]'} />
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-[var(--color-text-primary)]">
                                            {waStatus === 'connected' ? 'Connected to WhatsApp' : 'WhatsApp Disconnected'}
                                        </h4>
                                        <p className="text-sm text-[var(--color-text-muted)]">
                                            {waStatus === 'connected' ? `Linked as ${connectionState.phoneNumber || 'Business Account'}` : 'Link your business phone number to start responding'}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={openDialog}
                                    className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                                        waStatus === 'connected' 
                                        ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)]' 
                                        : 'bg-[#25D366] text-white hover:bg-[#25D366]/90'
                                    }`}
                                >
                                    {waStatus === 'connected' ? 'Manage Connection' : 'Connect Now'}
                                </button>
                            </div>

                            <div className="border-t border-[var(--color-border)] pt-6 mt-6 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-medium text-[var(--color-text-primary)]">Autonomous Bot Mode</p>
                                        <p className="text-xs text-[var(--color-text-muted)]">When enabled, the AI will automatically respond to all incoming messages.</p>
                                    </div>
                                    <div className="flex items-center h-6">
                                        <input
                                            type="checkbox"
                                            className="w-10 h-5 bg-gray-700 rounded-full appearance-none cursor-pointer checked:bg-[#25D366] relative transition-colors duration-200"
                                            style={{ boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)' }}
                                            checked={businessBotMode}
                                            onChange={(e) => setBusinessBotMode(e.target.checked)}
                                        />
                                    </div>
                                </div>

                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-medium text-[var(--color-text-primary)]">Response Permission</p>
                                        <p className="text-xs text-[var(--color-text-muted)]">Allow the bot to send messages. If disabled, it only monitors.</p>
                                    </div>
                                    <div className="flex items-center h-6">
                                        <input
                                            type="checkbox"
                                            className="w-10 h-5 bg-gray-700 rounded-full appearance-none cursor-pointer checked:bg-[var(--color-primary)] relative transition-colors duration-200"
                                            checked={whatsappEnabled}
                                            onChange={(e) => setWhatsAppEnabled(e.target.checked)}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 flex gap-3">
                            <Info size={18} className="text-blue-400 shrink-0 mt-0.5" />
                            <p className="text-xs text-blue-200/70 leading-relaxed">
                                <strong>Tip:</strong> Ensure your "Knowledge Base" is up to date. The bot uses your local files (PDFs, TXT) to answer customer questions accurately.
                            </p>
                        </div>
                    </div>
                )}

                {/* Business Tools Section (MCP) */}
                {activeSection === 'tools' && (
                    <div className="space-y-6">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Business Tools & Integrations</h3>
                                <p className="text-sm text-[var(--color-text-muted)]">Connect external tools that your bot can use (e.g., Google Calendar, Gmail, CRM)</p>
                            </div>
                            <button
                                onClick={() => {
                                    if (showMcpForm && editingMcpId) {
                                        setEditingMcpId(null);
                                    } else {
                                        setShowMcpForm(!showMcpForm);
                                    }
                                }}
                                className="flex items-center gap-2 px-4 py-2 bg-[var(--color-primary)] text-white rounded-lg text-sm font-bold hover:opacity-90 transition-all font-sans"
                            >
                                <Plus size={16} />
                                {editingMcpId ? "Add New Instead" : showMcpForm ? "Hide Form" : "Add Tool"}
                            </button>
                        </div>

                        {showMcpForm && (
                            <McpServerForm
                                editingServer={mcp.servers.find(s => s.id === editingMcpId) || null}
                                onSubmit={async (config) => {
                                    if (editingMcpId) await mcp.updateServer(editingMcpId, config);
                                    else await mcp.addServer(config);
                                    setShowMcpForm(false);
                                    setEditingMcpId(null);
                                }}
                                onCancel={() => {
                                    setShowMcpForm(false);
                                    setEditingMcpId(null);
                                }}
                            />
                        )}

                        <div className="grid gap-4">
                            {mcp.servers.filter(s => s.name !== 'playwright').map((server) => (
                                <McpServerCard
                                    key={server.id}
                                    server={server}
                                    isExpanded={expandedMcp === server.id}
                                    isEditing={editingMcpId === server.id}
                                    isConnecting={connectingMcp === server.id}
                                    onToggleExpand={() => setExpandedMcp(expandedMcp === server.id ? null : server.id)}
                                    onEdit={() => {
                                        setEditingMcpId(server.id);
                                        setShowMcpForm(true);
                                    }}
                                    onToggleConnection={async () => {
                                        setConnectingMcp(server.id);
                                        try {
                                            if (server.connected) await mcp.disconnectServer(server.id);
                                            else await mcp.connectServer(server.id);
                                        } finally {
                                            setConnectingMcp(null);
                                        }
                                    }}
                                    onRemove={() => {
                                        if (confirm("Remove this tool?")) mcp.removeServer(server.id);
                                    }}
                                    onTroubleshoot={() => {
                                        const prompt = `Troubleshoot MCP Tool: ${server.name}\nError: ${server.error}`;
                                        useChatStore.getState().addMessage({ role: 'user', content: prompt });
                                        alert("Troubleshooting request sent to AI. Check conversations.");
                                    }}
                                    onToggleAutoConnect={(enabled) => mcp.setAutoConnect(server.id, enabled)}
                                />
                            ))}
                            {mcp.servers.length <= 1 && (
                                <div className="text-center py-12 bg-[var(--color-surface)] border-2 border-dashed border-[var(--color-border)] rounded-xl">
                                    <Database size={32} className="mx-auto text-[var(--color-text-dim)] mb-3 opacity-20" />
                                    <p className="text-sm text-[var(--color-text-dim)]">No business tools connected yet.</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Account Section */}
                {/* REMOVED account section as requested */}

                {/* Memory Section */}
                {activeSection === 'memory' && (
                    <ErrorBoundary>
                        <div>
                            <h3 className="text-xl font-bold mb-6 text-[var(--color-text-primary)]">Knowledge Base (RAG)</h3>
                            <MemoryPreferencesPanel />
                        </div>
                    </ErrorBoundary>
                )}

                {/* LLM Provider Section */}
                {activeSection === 'llm' && (
                    <ErrorBoundary>
                        <div>
                            <h3 className="text-xl font-bold mb-6 text-[var(--color-text-primary)]">AI Model Configuration</h3>
                            <LLMProviderSettings />
                        </div>
                    </ErrorBoundary>
                )}

                {/* Voice Section */}
                {/* REMOVED voice section to simplify for business bot */}

                {/* Browser Automation Section */}
                {
                    activeSection === 'browser' && (
                        <div>
                            <h3 className="text-xl font-bold mb-6 text-[var(--color-text-primary)]">Browser Automation</h3>
                            <p className="text-[var(--color-text-secondary)] text-sm mb-6">
                                Configure the browser used by the AI agent for web automation tasks.
                            </p>

                            {/* Browser Selection */}
                            <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl p-4 mb-4">
                                <label className="block text-sm text-[var(--color-text-secondary)] mb-3">Browser Engine</label>
                                <select
                                    value={settings.playwrightBrowser || 'auto'}
                                    onChange={(e) => settings.setPlaywrightBrowser(e.target.value as any)}
                                    className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)]"
                                >
                                    <option value="auto">Auto (OS Default)</option>
                                    <option value="chrome">Google Chrome</option>
                                    <option value="msedge">Microsoft Edge</option>
                                    <option value="firefox">Mozilla Firefox</option>
                                    <option value="webkit">Safari (WebKit)</option>
                                    <option value="chromium">Chromium (Bundled)</option>
                                </select>
                                <p className="text-xs text-[var(--color-text-dim)] mt-2">
                                    Auto selects the best browser for your OS: Windows uses Edge, macOS/Linux use Chrome.
                                </p>
                            </div>

                            {/* Headless Mode */}
                            <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl p-4 mb-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <label className="block text-sm text-[var(--color-text-primary)] mb-1">Show Browser Window</label>
                                        <p className="text-xs text-[var(--color-text-muted)]">
                                            When enabled, you can see what the AI is doing in the browser.
                                        </p>
                                    </div>
                                    <input
                                        type="checkbox"
                                        className="toggle toggle-success"
                                        checked={!settings.playwrightHeadless}
                                        onChange={() => settings.setPlaywrightHeadless(!settings.playwrightHeadless)}
                                    />
                                </div>
                            </div>

                            {/* Info Box */}
                            <div className="bg-[var(--color-brand-teal)]/10 border border-[var(--color-brand-teal)]/30 rounded-xl p-4">
                                <div className="flex items-start gap-3">
                                    <Info size={20} className="text-[var(--color-brand-teal)] flex-shrink-0 mt-0.5" />
                                    <div className="text-sm text-[var(--color-text-secondary)]">
                                        <p className="font-medium text-[var(--color-text-primary)] mb-1">Session Persistence</p>
                                        <p>
                                            The browser maintains a dedicated profile for the AI agent.
                                            Login sessions and cookies are preserved between automation runs.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                }

                {/* Appearance Section */}
                {
                    activeSection === 'appearance' && (
                        <div>
                            <h3 className="text-xl font-bold mb-6 text-[var(--color-text-primary)]">Appearance</h3>

                            <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl p-4">
                                <label className="block text-sm text-[var(--color-text-secondary)] mb-3">Theme</label>
                                <div className="flex gap-2">
                                    {(['dark', 'light', 'system'] as Theme[]).map((theme) => (
                                        <button
                                            key={theme}
                                            onClick={() => settings.setTheme(theme)}
                                            className={`flex-1 py-2 px-4 rounded-lg text-sm capitalize transition-colors ${settings.theme === theme
                                                ? 'bg-[var(--color-brand-teal)] text-[var(--color-text-inverse)]'
                                                : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'
                                                }`}
                                        >
                                            {theme}
                                        </button>
                                    ))}
                                </div>
                                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                                    Choose your preferred color scheme. System follows your OS preference.
                                </p>
                            </div>
                        </div>
                    )
                }

                {/* Audit Logs Section */}
                {
                    activeSection === 'logs' && (
                        <div>
                            <h3 className="text-xl font-bold mb-6 text-[var(--color-text-primary)]">Audit Logs</h3>
                            <div className="bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-xl p-6">
                                <div className="flex items-start gap-4 mb-6">
                                    <div className="p-3 bg-blue-500/10 rounded-lg">
                                        <FileText className="text-blue-400" size={24} />
                                    </div>
                                    <div>
                                        <h4 className="font-medium mb-1 text-[var(--color-text-primary)]">Corporate Logging Enabled</h4>
                                        <p className="text-sm text-[var(--color-text-secondary)]">
                                            All chat sessions, prompts, and tool executions are logged to the local file system for auditing purposes.
                                            Logs are strictly append-only.
                                        </p>
                                    </div>
                                </div>

                                <div className="bg-[var(--color-surface)] rounded-lg p-4 mb-4">
                                    <label className="text-[10px] uppercase font-bold text-[var(--color-text-dim)] mb-2 block">Local Log Path</label>
                                    <code className="text-xs text-[var(--color-text-primary)] font-mono break-all block select-all">
                                        {logPath || 'Loading...'}
                                    </code>
                                </div>

                                <button
                                    onClick={() => openLogFolder()}
                                    className="flex items-center gap-2 px-4 py-2 bg-[var(--color-surface)] hover:bg-[var(--color-border)] text-[var(--color-text-primary)] rounded-lg transition-colors text-sm"
                                >
                                    <FolderOpen size={16} />
                                    Reveal in File Explorer
                                </button>
                            </div>
                        </div>
                    )
                }

                {/* REMOVED flags section */}

                {/* About Section */}
                {
                    activeSection === 'about' && (
                        <div className="space-y-6">
                            <h3 className="text-[var(--text-xl)] font-[var(--font-weight-bold)] text-[var(--color-text-primary)]">About</h3>

                            <Card variant="glass" padding="lg" className="text-center">
                                <div className="w-20 h-20 bg-[var(--color-primary)] rounded-[var(--radius-xl)] flex items-center justify-center mx-auto mb-[var(--space-4)] shadow-lg">
                                    <Sparkles className="w-10 h-10 text-[var(--color-text-inverse)]" />
                                </div>
                                <h4 className="text-[var(--text-2xl)] font-[var(--font-weight-bold)] text-[var(--color-text-primary)]">{APP_INFO.NAME}</h4>
                                <p className="text-[var(--text-sm)] text-[var(--color-text-muted)] mt-[var(--space-1)]">Version {APP_INFO.VERSION}</p>
                                <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)] mt-[var(--space-4)] max-w-sm mx-auto">
                                    Voice-first desktop workspace with MCP integration. Built for AI-assisted productivity.
                                </p>
                                <div className="mt-[var(--space-6)] pt-[var(--space-4)] border-t border-[var(--color-border)]">
                                    <p className="text-[var(--text-xs)] text-[var(--color-text-dim)]">
                                        Built with Electron, React, and TypeScript
                                    </p>
                                </div>
                            </Card>

                            <div className="grid grid-cols-2 gap-[var(--space-3)]">
                                <Card variant="default" padding="md" className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-success)]/15 flex items-center justify-center">
                                        <Activity className="w-5 h-5 text-[var(--color-success)]" />
                                    </div>
                                    <div>
                                        <p className="text-[var(--text-xs)] text-[var(--color-text-dim)]">Status</p>
                                        <StatusBadge variant="success" label="Active" animated />
                                    </div>
                                </Card>
                                <Card variant="default" padding="md" className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-primary)]/15 flex items-center justify-center">
                                        <Zap className="w-5 h-5 text-[var(--color-primary)]" />
                                    </div>
                                    <div>
                                        <p className="text-[var(--text-xs)] text-[var(--color-text-dim)]">Platform</p>
                                        <p className="text-[var(--text-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">Electron</p>
                                    </div>
                                </Card>
                                <Card variant="default" padding="md" className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-accent)]/15 flex items-center justify-center">
                                        <Clock className="w-5 h-5 text-[var(--color-accent)]" />
                                    </div>
                                    <div>
                                        <p className="text-[var(--text-xs)] text-[var(--color-text-dim)]">Launch</p>
                                        <p className="text-[var(--text-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">Ready</p>
                                    </div>
                                </Card>
                                <Card variant="default" padding="md" className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-brand-teal)]/15 flex items-center justify-center">
                                        <Cpu className="w-5 h-5 text-[var(--color-brand-teal)]" />
                                    </div>
                                    <div>
                                        <p className="text-[var(--text-xs)] text-[var(--color-text-dim)]">Engine</p>
                                        <p className="text-[var(--text-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">React</p>
                                    </div>
                                </Card>
                            </div>

                            <SystemDependenciesSettings />
                        </div>
                    )
                }
            </div>
        </div>
    )
}
