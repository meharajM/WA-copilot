# WA-Copilot: WhatsApp Business Agent Architecture

## Overview
WA-Copilot is an autonomous WhatsApp Business Customer Support Agent built as a desktop application using Electron, React, and local/remote LLM capabilities. It serves as an intelligent middle-layer, connecting a business owner's WhatsApp account directly to a knowledge base (RAG) and external business tools (via MCP) to autonomously handle incoming customer inquiries.

The system is designed with a "local-first" philosophy, capable of running entirely on-device (via WebLLM/Ollama) while gracefully falling back to cloud providers (OpenAI/Gemini/OpenRouter) for complex reasoning tasks.

## High-Level Architecture
The application follows the standard Electron multi-process architecture but injects a powerful local agent runtime into the renderer process for low-latency reasoning.

```mermaid
graph TD
    subgraph "WhatsApp Ecosystem"
        WA[WhatsApp Service]
    end

    subgraph "Electron Main Process (Node.js)"
        Baileys[WhatsApp Baileys Bridge]
        RAG[Local RAG Engine (LanceDB)]
        FS[File System & DB]
        IPC_MAIN[IPC Event Bus]
    end

    subgraph "Electron Renderer Process (React/Chrome)"
        UI[UI Components]
        Stores[Zustand Stores]
        
        subgraph "Agent Subsystem"
            Runtime[AgentRuntime]
            LLM[LLM Orchestrator]
            MCP[MCP Tool Hub]
            Memory[Memory Reflector]
        end
    end

    WA <-->|Sockets| Baileys
    Baileys <-->|IPC| IPC_MAIN
    IPC_MAIN <--> Stores
    
    UI --> Stores
    Stores --> Runtime
    
    Runtime --> LLM
    Runtime --> MCP
    Runtime --> Memory
    
    LLM -->|Local Embeddings| RAG
```

## Core Components

### 1. Main Process (`src/main/`)
The main process handles operations that require direct OS/network access, skipping the sandbox restrictions of the browser.

*   **WhatsApp Bridge (`/whatsapp`)**: Utilizes the Baileys library to establish a persistent WebSocket connection to WhatsApp servers. It handles QR code authentication, message parsing, typing indicators, and inbound media buffering.
*   **RAG Engine (`/rag`)**: An embedded vector database (LanceDB) and document ingestion pipeline. It allows business owners to drag-and-drop PDFs, CSVs, and text documents, which are automatically chunked, embedded, and indexed locally for the agent to search.
*   **IPC Handlers (`/ipc`)**: The communication spine bridging the Main and Renderer processes. It passes WhatsApp events (messages, connection status) up to the UI and accepts agent responses down to the WhatsApp socket.

### 2. Renderer Process (`src/renderer/src/`)
The renderer process houses the React UI and, crucially, the autonomous agent logic.

#### UI Layer (`/components`)
*   **Dashboard (`EmptyState.tsx`)**: The primary view for the business owner. Displays real-time metrics (Messages Today, Active Leads, Knowledge Docs) and **Conversation Topics** analytics. It includes a "Train AI" zone for PDF/TXT ingestion and a "Sync Insights" trigger for LLM-based session analysis.
*   **Settings (`SettingsPanel.tsx`)**: A clean interface for managing the WhatsApp connection and choosing LLM providers. Access to core bot logic is restricted to ensure safe autonomous operation.
*   **Chat View (`ChatView.tsx`)**: A live debugging and manual intervention interface. It includes a **"Resolve Conversation"** action that marks a customer interaction as finished, triggering the analytics pipeline.

#### State Management (`/stores`)
*   **`useChatStore`**: Manages the multi-session context constraint. Crucially, it maps incoming WhatsApp messages from distinct JIDs (phone numbers) to isolated LLM conversation histories.
*   **`useWhatsAppStore`**: Tracks the Baileys connection state, QR code base64 generation, and the master "Bot Enabled/Disabled" boolean.
*   **`useMcpStore`**: Maintains the registry of connected Model Context Protocol (MCP) servers, allowing the agent to dynamically execute custom scripts or API calls (e.g., checking order status via a Shopify MCP server).

#### Agent Subsystem (`/lib`)
This is the "brain" of the application, intercepting messages and orchestrating the LLM.

*   **`AgentRuntime` (`agent-runtime.ts`)**: The core loop. It receives an incoming message (either from the UI or WhatsApp), checks for context limits, identifies necessary tools, and iterates through a Thought → Action → Observation loop until a final answer is ready.
*   **Task Orchestration (`agent/OrchestrationService.ts`)**: For complex business requests, the agent can spawn parallel "sub-agents" to handle independent tasks (e.g., retrieving shipping status while simultaneously parsing a refund policy document).
*   **LLM Router (`llm/index.ts`)**: An abstraction layer that standardizes API formats across various providers. It intelligently routes reasoning tasks to large server models and fast, repetitive tasks to on-device models.
*   **Prompt Engineering (`llm/prompts.ts`)**: Constructs the dynamic system prompt. It injects the `BUSINESS BOT PERSONA`, enforces formatting rules, and dynamically lists available tools based on the current context.

## Data Flow: Inbound Customer Message

1.  **Transport**: Customer texts the business number. The message hits WhatsApp servers and is pushed via WebSocket to the `Baileys` client in the Main Process.
2.  **IPC Bridge**: The Main process emits an `on-message` event via Electron IPC representing a new raw message envelope.
3.  **State Hydration**: The Renderer's `useWhatsAppBridge` hook catches the IPC event. It checks the sender's JID.
    *   If a session exists for this JID, the message appends to it.
    *   If it's a new customer, a new isolated `ChatSession` is created.
4.  **Agent Trigger**: The `app:submit-message` event is fired. The `useAgent` hook instantiates the `AgentRuntime` scoped specifically to that JID's session.
5.  **Reasoning Loop**: The `AgentRuntime` pulls the conversation history and queries the LLM. The LLM may decide to call `rag_search` to look up store policies.
6.  **Outbound Dispatch**: Once the LLM finalizes its response (outside of `<think>` tags), `useAgent` makes a cross-process call back to the Main process to dispatch the text via Baileys to the customer's phone.

## Security & Privacy
*   **Local First**: All business data embedded into the RAG system and all chat history remains stored on the host machine's SQLite/LanceDB implementations.
*   **No Unintended Delivery**: The system differentiates between the 'App UI' and 'WhatsApp'. The agent will only push outbound messages to WhatsApp if the originating signal carried a valid target JID.

## Upcoming Phases (Phase 3+)
The application is structured to decouple the `AgentRuntime` from the React thread. Future development aims to extract the agent loops into robust background Web Workers or a completely unbundled Node.js microservice (`RemoteAgentClient`), enabling headless execution free from the UI's lifecycle.
