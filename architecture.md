# AIConsumerAgent: WhatsApp Business Agent Architecture

## Overview
AIConsumerAgent is an autonomous WhatsApp Business Customer Support Agent built as a desktop application using Electron, React, and local/remote LLM capabilities. It serves as an intelligent middle-layer, connecting a business owner's WhatsApp account directly to a knowledge base (RAG) and external business tools (via MCP) to autonomously handle incoming customer inquiries.

The system is designed with a **"local-first" philosophy**, capable of running entirely on-device (via WebLLM/Ollama) while gracefully falling back to cloud providers (OpenAI/Gemini/OpenRouter) for complex reasoning tasks.

## High-Level Architecture
The application follows the standard Electron multi-process architecture, distributing responsibilities between the Node.js main process (system access) and the Chromium renderer process (UI and agent logic).

```mermaid
graph TD
    subgraph "WhatsApp Ecosystem"
        WA[WhatsApp Service]
    end

    subgraph "Electron Main Process (Node.js)"
        Baileys[WhatsApp Baileys Bridge]
        RAG[RAG Engine (SQLite FTS5)]
        SQLite[storage.db WhatsApp/Chat DB]
        Persistence[Persistence & Mirror Service]
        AdminRelay[AdminRelayService]
        IPC_MAIN[IPC Event Bus]
    end

    subgraph "Electron Renderer Process (React/Chrome)"
        UI[UI Components]
        Stores[Zustand Stores]
        
        subgraph "Agent Subsystem"
            Runtime[AgentRuntime]
            Router[LLM Router]
            MCP[MCP Tool Hub]
            Memory[Memory Reflector]
        end
    end

    WA <-->|Sockets| Baileys
    Baileys <-->|IPC| IPC_MAIN
    IPC_MAIN <--> Stores
    
    Persistence <--> SQLite
    Baileys --> Persistence
    AdminRelay --> Baileys
    
    UI --> Stores
    Stores --> Runtime
    
    Runtime --> Router
    Runtime --> MCP
    Runtime --> Memory
    
    MCP -->|Escalation Tool| AdminRelay
    Router -->|FTS Search| RAG
```

## Core Components

### 1. Main Process (`src/main/`)
The main process handles operations that require direct OS/network access, skipping the sandbox restrictions of the browser.

*   **WhatsApp Bridge (`/whatsapp`)**: Utilizes the **Baileys** library to establish a persistent WebSocket connection to WhatsApp servers. 
    *   **Auth**: Persisted in `whatsapp-auth/` via `useMultiFileAuthState`.
    *   **Handshake**: Implements a 6-digit verification code loop to link personal accounts to the worker instance.
    *   **Rate Limiting**: Throttles outbound messages to 1 msg/sec to prevent account flagging.
*   **RAG Engine (`/rag`)**: An embedded knowledge base powered by **SQLite FTS5** (Full-Text Search).
    *   **Ingestion**: Uses `uvx markitdown` to convert PDFs, DOCX, and CSVs into clean Markdown before indexing.
    *   **Service**: Managed by `RAGService.ts` using `better-sqlite3`.
*   **Agent Persistence Layer**: 
    *   **SQLite Storage**: `ChatPersistenceService` logs every WhatsApp and Agent message into `storage.db`. This provides high-performance querying for the UI and long-term history.
    *   **Session Mirroring**: `SessionMirrorService` automatically mirrors the SQLite data into individual `.json` files within the `brain/sessions/` directory. This ensures 100% data portability and easy backup/export.
*   **Admin Relay Service**:
    *   **Human-in-the-Loop**: Manages the escalation of unresolved queries. It tracks "unresolved" states and handles the routing of admin replies back to the original customer via message quoting.
    *   **Relay Logic**: Maps outbound admin notification message IDs to customer JIDs to ensure replies are delivered to the correct recipient.

### 2. Renderer Process (`src/renderer/src/`)
The renderer process houses the React UI and the autonomous agent logic.

#### UI Layer (`/components`)
*   **Dashboard (`EmptyState.tsx`)**: Displays real-time metrics and conversation topics.
*   **Settings (`SettingsPanel.tsx`)**: Manages LLM providers, WhatsApp controls, email channel setup, memory, and theme preferences.
*   **Conversations (`ChatView.tsx`)**: Manual intervention interface for omnichannel sessions including WhatsApp and email.

#### State Management (`/stores`)
*   **`useChatStore`**: Manages omnichannel chat sessions, messages, and channel/contact metadata. In the browser workspace, the durable session source is the authenticated `agentd` API; the store is a renderer projection, not a second database.
*   **`useWhatsAppStore`**: Tracks connection status, QR codes, response permission, and the legacy autonomous-bot flag. Browser mode persists response permission/target state through authenticated agentd UI settings, never persists the autonomous flag, and uses response permission only for review and explicit sends; the Electron transition client retains the existing local path.
*   **`useMcpStore`**: Maintains the Electron transition-client registry of connected **Model Context Protocol** servers and an agentd-owned browser projection. Browser mode uses the supervised worker for approved external servers; internal Playwright/filesystem/native definitions remain fail-closed.

#### Agent Subsystem (`/lib`)
This is the "brain" of the application, orchestrating the LLM reasoning loop.

*   **`AgentRuntime` (`agent-runtime.ts`)**: The orchestrator. It manages the Thought → Action → Observation loop. It delegates specialized tasks to three sub-services:
    *   **`AgentStateService`**: Manages the memory lifecycle and session handoffs.
    *   **`ToolExecutionService`**: Handles tool calls with self-healing retries and output truncation.
    *   **`OrchestrationService`**: Handles complex tasks by spawning parallel or sequential sub-agents.
*   **LLM Router (`llm.ts`)**: An abstraction layer that standardizes API formats across **WebLLM** (Browser-based models), **Ollama** (Local server), and **Cloud Providers**.
*   **Prompt Engineering (`llm/prompts.ts`)**: Dynamically constructs system prompts, injecting business personas and tool definitions based on context.

## Data Flow: Inbound Customer Message

The repository currently has two deliberately different runtime paths while the browser migration is completed:

### Electron transition client

1. **Reception**: Customer messages are received by the Electron main-process Baileys service.
2. **Ingestion**: Supported Electron document/media handling stays in the legacy native pipeline, including the existing parser/RAG integrations.
3. **IPC dispatch**: The main process emits bounded events to the renderer.
4. **Session mapping**: `useWhatsAppBridge` maps the sender JID to a channel-bound `ChatSession`.
5. **Agent trigger**: When the Electron response-permission/autonomous gates allow it, `AgentRuntime` runs the existing reasoning loop.
6. **Delivery and audit**: Tool calls, courtesy/escalation behavior, provider delivery, SQLite persistence and the legacy filesystem mirror remain Electron-owned.

### Browser workspace

1. **Reception**: The lazy `agentd` Baileys worker owns the local WhatsApp socket and persists normalized inbound events in daemon SQLite. It ignores self, broadcast/system and caption-less media messages; bounded text and media captions are the only browser ingress.
2. **Claim and hydrate**: When the browser's WhatsApp response-permission gate is enabled, `useWhatsAppBridge` polls the authenticated event queue, creates/reuses the deterministic agentd-backed session, and appends the message idempotently. The browser never receives auth files or a native path.
3. **No autonomous execution yet**: Browser `Autonomous Bot Mode` is disabled/cleared. This slice does not invoke the Electron `AgentRuntime`, confidence policy, courtesy/escalation loop or autonomous direct-send path.
4. **Explicit delivery**: Text sends and approved text-only drafts use authenticated agentd routes. The daemon owns transport credentials, outbox state and duplicate suppression; media delivery, WhatsApp Web automation and autonomous direct-send remain fail-closed until their adapters are migrated.
5. **Persistence**: Browser sessions, events and outbox records are durable in agentd SQLite. The browser store is only a projection and no longer writes a competing Electron database.

## Security & Privacy
*   **Local ownership**: Browser product records, credentials and channel auth remain on the user's machine under the supervised `agentd` data directory; the Tauri companion exposes only typed native capabilities and never becomes a generic product proxy.
*   **Provider boundary**: Cloud LLM use still sends the requested prompt/attachments to the selected provider. WebLLM WebGPU and loopback Ollama are local-model paths, subject to the browser/daemon runtime selected by the user.
*   **App isolation**: Each customer conversation is mapped to a bounded channel/contact session, with authenticated daemon routes and per-session writes preventing cross-customer leakage.

## Future Roadmap (Phase 3+)
The architecture is prepared for **Headless Execution**. By extraction of the `AgentRuntime` logic into a Node.js microservice or dedicated Worker thread, the agent can continue responding to WhatsApp messages even when the UI window is closed or the machine is under significant load.
