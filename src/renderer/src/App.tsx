import React, { useState, useEffect } from "react";

import { ChatView } from "./components/ChatView";
import { SettingsPanel } from "./components/SettingsPanel";
import { FileChangeReview } from "./components/FileChangeReview";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar, ViewMode } from "./components/Sidebar";
import { KnowledgeBrowser } from "./components/chat/KnowledgeBrowser";
import { LeadDirectory } from "./components/chat/LeadDirectory";
import { Header } from "./components/Header";
import { WhatsAppConnectionDialog } from "./components/WhatsAppConnectionDialog";
import { EmptyState } from "./components/chat/EmptyState";
import { ChatInput } from "./components/input/ChatInput";

import { useResolutionAudit } from './hooks/useResolutionAudit'
import { useChatStore } from "./stores/chatStore";
import { useMcpStore } from "./stores/mcpStore";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useLLMStatus } from "./hooks/useLLMStatus";
import { useWhatsAppBridge } from "./hooks/useWhatsAppBridge";
import { useAgent } from "./hooks/useAgent";
import { useAuthPersistence } from "./hooks/useAuthPersistence";
import { MissingDependenciesScreen } from "./components/MissingDependenciesScreen";
import { ExperimentProvider } from "./lib/experiments/experimentProvider";
import { useThemeSync } from "./hooks/useThemeSync";

function App() {
  const [currentView, setCurrentView] = useState<ViewMode>("dashboard");
  const [dependenciesResolved, setDependenciesResolved] = useState(() => {
    return import.meta.env.MODE === 'test'
  });

  useEffect(() => {
    const triggerCheck = () => setDependenciesResolved(false);
    window.addEventListener('app:check-dependencies', triggerCheck);
    return () => window.removeEventListener('app:check-dependencies', triggerCheck);
  }, []);

  // ── Store subscriptions ───────────────────────────────────────────────────
  const {
    activeSessionId,
    isSessionProcessing,
    abortSession,
  } = useChatStore();

  const { handleSubmit } = useAgent();
  const activeIsProcessing = activeSessionId ? isSessionProcessing(activeSessionId) : false;

  // Removed automatic redirection from dashboard to chat to allow navigation.
  // Session navigation is handled explicitly by clicking sessions in the sidebar.

  const renderContent = () => {
    switch (currentView) {
      case 'dashboard':
        return <EmptyState onNavigate={setCurrentView} />
      case 'brain':
        return <KnowledgeBrowser />
      case 'leads':
        return <LeadDirectory />
      case 'settings':
      case 'connections':
      case 'identity':
        return <SettingsPanel 
          initialSection={currentView === 'connections' ? 'tools' : currentView === 'identity' ? 'identity' : 'whatsapp'} 
          onClose={() => setCurrentView('dashboard')} 
        />
      case 'chat':
        return (
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <ChatView />
            <ChatInput
              onSubmit={handleSubmit}
              disabled={activeIsProcessing}
              onAbort={activeSessionId ? () => abortSession(activeSessionId) : undefined}
            />
          </div>
        )
      default:
        return <EmptyState onNavigate={setCurrentView} />
    }
  }

  // ── Side-effect hooks ─────────────────────────────────────────────────────
  useSettingsSync();
  useThemeSync();
  useAuthPersistence();
  useWhatsAppBridge();
  useResolutionAudit();

  useEffect(() => {
    const mcp = useMcpStore.getState();
    if (!mcp.initialized) {
      mcp.initialize();
    }
  }, []);

  const { llmStatus } = useLLMStatus(currentView);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ExperimentProvider>
      <div className="flex h-screen bg-[#0f1115] text-white font-sans overflow-hidden">
        <CommandPalette onViewChange={setCurrentView} />
        {!dependenciesResolved && <MissingDependenciesScreen onResolved={() => setDependenciesResolved(true)} />}
        
        {/* Only show main sidebar when not in system settings to avoid double-sidebar clutter */}
        {currentView !== 'settings' && currentView !== 'connections' && currentView !== 'identity' && (
          <Sidebar activeView={currentView} onViewChange={setCurrentView} />
        )}

        <div className="flex-1 flex flex-col relative min-w-0">
          <Header 
            status={llmStatus}
            currentView={currentView}
            onViewChange={setCurrentView}
          />

          <main className="flex-1 flex flex-col overflow-hidden min-w-0">
            {renderContent()}
          </main>
        </div>

        <FileChangeReview />
        <WhatsAppConnectionDialog />
      </div>
    </ExperimentProvider>
  );
}

export default App;
