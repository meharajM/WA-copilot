import React, { lazy, Suspense, useState, useEffect } from "react";

import { CommandPalette } from "./components/CommandPalette";
import { Sidebar, ViewMode } from "./components/Sidebar";
import { Header } from "./components/Header";

// Keep the browser's first render small. Feature panels retain their existing
// behavior, but load only when the user opens that surface; this matters on
// Windows where browser RAM should remain available for a local model.
const ChatView = lazy(() => import("./components/ChatView").then(({ ChatView: view }) => ({ default: view })))
const SettingsPanel = lazy(() => import("./components/SettingsPanel").then(({ SettingsPanel: panel }) => ({ default: panel })))
const FileChangeReview = lazy(() => import("./components/FileChangeReview").then(({ FileChangeReview: review }) => ({ default: review })))
const KnowledgeBrowser = lazy(() => import("./components/chat/KnowledgeBrowser").then(({ KnowledgeBrowser: browser }) => ({ default: browser })))
const LeadDirectory = lazy(() => import("./components/chat/LeadDirectory").then(({ LeadDirectory: directory }) => ({ default: directory })))
const WhatsAppConnectionDialog = lazy(() => import("./components/WhatsAppConnectionDialog").then(({ WhatsAppConnectionDialog: dialog }) => ({ default: dialog })))
const EmptyState = lazy(() => import("./components/chat/EmptyState").then(({ EmptyState: state }) => ({ default: state })))
const ChatInput = lazy(() => import("./components/input/ChatInput").then(({ ChatInput: input }) => ({ default: input })))
const DraftApprovalPanel = lazy(() => import("./components/email/DraftApprovalPanel").then(({ DraftApprovalPanel: panel }) => ({ default: panel })))

import { useResolutionAudit } from './hooks/useResolutionAudit'
import { useChatStore } from "./stores/chatStore";
import { useMcpStore } from "./stores/mcpStore";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useLLMStatus } from "./hooks/useLLMStatus";
import { useWhatsAppBridge } from "./hooks/useWhatsAppBridge";
import { useEmailBridge } from "./hooks/useEmailBridge";
import { useAgent } from "./hooks/useAgent";
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
    const openDrafts = () => setCurrentView('drafts');
    window.addEventListener('app:open-drafts', openDrafts as EventListener);
    return () => {
      window.removeEventListener('app:check-dependencies', triggerCheck);
      window.removeEventListener('app:open-drafts', openDrafts as EventListener);
    };
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
        return <LeadDirectory onOpenChat={() => setCurrentView('chat')} />
      case 'drafts':
        return (
          <div className="flex-1 overflow-y-auto p-10 bg-[var(--color-bg-dark)]">
            <DraftApprovalPanel />
          </div>
        )
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
  useWhatsAppBridge();
  useEmailBridge();
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
            <Suspense fallback={<div className="flex-1 grid place-items-center text-sm text-white/50">Loading workspace…</div>}>
              {renderContent()}
            </Suspense>
          </main>
        </div>

        <FileChangeReview />
        <WhatsAppConnectionDialog />
      </div>
    </ExperimentProvider>
  );
}

export default App;
