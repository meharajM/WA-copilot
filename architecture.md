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
*   **`useChatStore`**: Manages omnichannel chat sessions, messages, and channel/contact metadata.
*   **`useWhatsAppStore`**: Tracks connection status, QR codes, response permission, and autonomous bot mode.
*   **`useMcpStore`**: Maintains the registry of connected **Model Context Protocol** servers.

#### Agent Subsystem (`/lib`)
This is the "brain" of the application, orchestrating the LLM reasoning loop.

*   **`AgentRuntime` (`agent-runtime.ts`)**: The orchestrator. It manages the Thought → Action → Observation loop. It delegates specialized tasks to three sub-services:
    *   **`AgentStateService`**: Manages the memory lifecycle and session handoffs.
    *   **`ToolExecutionService`**: Handles tool calls with self-healing retries and output truncation.
    *   **`OrchestrationService`**: Handles complex tasks by spawning parallel or sequential sub-agents.
*   **LLM Router (`llm.ts`)**: An abstraction layer that standardizes API formats across **WebLLM** (Browser-based models), **Ollama** (Local server), and **Cloud Providers**.
*   **Prompt Engineering (`llm/prompts.ts`)**: Dynamically constructs system prompts, injecting business personas and tool definitions based on context.

## Data Flow: Inbound Customer Message

1.  **Reception**: Customer message is received by `Baileys` in the Main process via WebSocket.
2.  **Ingestion**: If the message contains a document, it is automatically converted via `markitdown` and indexed into the **RAG Engine**.
3.  **IPC Dispatch**: The message is emitted via IPC to the Renderer.
4.  **Session Mapping**: `useWhatsAppBridge` identifies the sender's JID and assigns the message to a specific `ChatSession`.
5.  **Agent Trigger**: If inbound WhatsApp handling is enabled through response permission or autonomous bot mode, the `AgentRuntime` starts the reasoning loop.
6.  **RAG Lookup**: The agent performs a `rag_search` to find business-specific answers.
7.  **Proactive Monitoring**: If execution exceeds 60 seconds, `useAgent` dispatches a courtesy "Still working..." message to the customer.
8.  **Escalation (Optional)**: If the query is unresolved (no RAG match), the agent calls `whatsapp_notify_admin`.
9.  **Response**: Once a final response is generated, it is dispatched via IPC to the Main process and delivered to the customer.
10. **Persistence**: The interaction is simultaneously committed to the SQLite DB and mirrored to the filesystem for sovereignty.

## Security & Privacy
*   **Zero-Cloud Retention**: All chat logs and RAG indices are stored in the app's `userData` folder. No third-party servers see business knowledge except the selected LLM provider.
*   **Local Inference**: When using WebLLM or Ollama, zero message content leaves the host machine.
*   **App Isolation**: Each customer JID is treated as a separate context, preventing cross-customer data leakage.

## Future Roadmap (Phase 3+)
The architecture is prepared for **Headless Execution**. By extraction of the `AgentRuntime` logic into a Node.js microservice or dedicated Worker thread, the agent can continue responding to WhatsApp messages even when the UI window is closed or the machine is under significant load.
