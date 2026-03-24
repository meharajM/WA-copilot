import React, { useState, useEffect } from "react";

import { ChatView } from "./components/ChatView";
import { SettingsPanel } from "./components/SettingsPanel";
import { FileChangeReview } from "./components/FileChangeReview";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar, View } from "./components/Sidebar";
import { Header } from "./components/Header";
import { WhatsAppConnectionDialog } from "./components/WhatsAppConnectionDialog";

import { useChatStore } from "./stores/chatStore";
import { useMcpStore } from "./stores/mcpStore";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useAgent } from "./hooks/useAgent";
import { useLLMStatus } from "./hooks/useLLMStatus";
import { useWhatsAppBridge } from "./hooks/useWhatsAppBridge";
import { MissingDependenciesScreen } from "./components/MissingDependenciesScreen";
import { ExperimentProvider } from "./lib/experiments/experimentProvider";
import { useThemeSync } from "./hooks/useThemeSync";

function App() {
  const [currentView, setCurrentView] = useState<View>("dashboard");
  const [dependenciesResolved, setDependenciesResolved] = useState(() => {
    // Only skip the long background shell check during automated test runs.
    // Using process.env.NODE_ENV ensures this bypass is compile-time and
    // can never leak into production or persist across user sessions.
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
    sessions,
    isSessionProcessing,
    abortSession,
  } = useChatStore();

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  // Whether the currently-active session is processing (used to disable the input)
  const activeIsProcessing = activeSessionId ? isSessionProcessing(activeSessionId) : false;

  // ── Side-effect hooks ─────────────────────────────────────────────────────
  useSettingsSync();
  useThemeSync();
  useWhatsAppBridge(); // Sync WhatsApp IPC events → whatsappStore

  // Ensure MCP is initialized for the chat view. ConnectionsPanel also calls
  // initialize(), but we need it ready before the user opens that panel.
  useEffect(() => {
    const mcp = useMcpStore.getState();
    if (!mcp.initialized) {
      mcp.initialize();
    }
  }, []);

  // ── Business logic hooks ──────────────────────────────────────────────────
  // All agent execution logic lives in useAgent. All LLM status polling lives
  // in useLLMStatus. App.tsx just wires their outputs to the UI.

  const { handleSubmit } = useAgent();
  const { llmStatus } = useLLMStatus(currentView);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <ExperimentProvider>
    <div className="flex h-screen bg-[var(--color-bg-dark)] text-[var(--color-text-primary)] font-sans overflow-hidden">
      <CommandPalette onViewChange={setCurrentView} />
      {!dependenciesResolved && <MissingDependenciesScreen onResolved={() => setDependenciesResolved(true)} />}
      
      {currentView !== "settings" && (
        <Sidebar currentView={currentView} onViewChange={setCurrentView} />
      )}

      <div className="flex-1 flex flex-col relative min-w-0">
        <Header 
          status={llmStatus} 
          currentView={currentView} 
          onViewChange={setCurrentView} 
        />

        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          {currentView === "dashboard" && (
            <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative bg-[var(--color-bg-dark)]">
              <ChatView /> {/* Updated EmptyState is here */}
            </div>
          )}

          {currentView === "chat" && (
            <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
              <div className="flex-1 overflow-hidden flex flex-col relative w-full h-full pb-0 bg-[var(--color-bg-dark)] z-0">
                <ChatView />
              </div>
            </div>
          )}

          {currentView === "settings" && <SettingsPanel onClose={() => setCurrentView("chat")} />}
        </main>
      </div>

      <FileChangeReview />
      <WhatsAppConnectionDialog />
    </div>
    </ExperimentProvider>
  );
}

export default App;
