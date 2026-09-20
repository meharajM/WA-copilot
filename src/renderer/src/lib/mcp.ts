import { useMcpStore, MCPServer, MCPTool } from "../stores/mcpStore";
import electron from "./electron";
import { useDraftStore } from "../stores/draftStore";
import { createDraftResponse } from "./email-policy";
import { enforceToolCallPolicy } from "./tool-policy";
import { getBrowserAgentdClient } from "./browser-agentd-client";
import { isTauriRuntime } from "./tauri-native-bridge";

/// <reference path="../env.d.ts" />

// Add a custom server
export async function addCustomServer(
  config: Omit<MCPServer, "id" | "connected" | "tools" | "autoConnect">
): Promise<void> {
  return useMcpStore.getState().addServer(config);
}

// Update an existing server - Delegated to store
export async function updateServer(
  serverId: string,
  config: Partial<Omit<MCPServer, "id" | "connected" | "tools">>
): Promise<void> {
  return useMcpStore.getState().updateServer(serverId, config);
}

// Remove a server - Delegated to store
export async function removeServer(serverId: string): Promise<void> {
  return useMcpStore.getState().removeServer(serverId);
}

// Get all servers - FROM STORE
export function getServers(): MCPServer[] {
  return useMcpStore.getState().servers;
}

// Connect to a server - Delegated to store
export async function connectServer(serverId: string): Promise<void> {
  return useMcpStore.getState().connectServer(serverId);
}

// Disconnect from a server - Delegated to store
export async function disconnectServer(serverId: string): Promise<void> {
  return useMcpStore.getState().disconnectServer(serverId);
}

// Get all available tools - FROM STORE
export function getAllTools(): MCPTool[] {
  return useMcpStore.getState().getAllTools();
}

// Find which server a tool belongs to - FROM STORE
export function findServerForTool(toolName: string): MCPServer | null {
  return useMcpStore.getState().findServerForTool(toolName);
}

/** Browser MCP uses the authenticated supervised agentd worker; Electron keeps its existing client. */
export async function getBrowserMcpLifecycle() {
  if (!isBrowserProduct()) return null;
  return getBrowserAgentdClient().getMcpLifecycle();
}

// Logging utility for renderer process
function logMcpRenderer(
  level: "info" | "warn" | "error",
  message: string,
  context: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();

  const logMessage = `[MCP Renderer ${level.toUpperCase()}] ${timestamp} - ${message}`;

  switch (level) {
    case "error":
      console.error(logMessage, context);
      break;
    case "warn":
      console.warn(logMessage, context);
      break;
    default:
      console.log(logMessage, context);
  }
}

// Sanitize arguments for logging (remove sensitive data)
function sanitizeArgsForLogging(
  args: Record<string, unknown>
): Record<string, unknown> {
  const sanitized = { ...args };
  const sensitiveKeys = [
    "password",
    "apiKey",
    "token",
    "secret",
    "key",
    "auth",
  ];

  for (const key in sanitized) {
    if (
      sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))
    ) {
      sanitized[key] = "***REDACTED***";
    } else if (typeof sanitized[key] === "object" && sanitized[key] !== null) {
      sanitized[key] = sanitizeArgsForLogging(
        sanitized[key] as Record<string, unknown>
      );
    }
  }

  return sanitized;
}

// Helper to ensure args is a record
function ensureRecord(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return args || {};
}

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()

// Execute a tool call with retry logic for connection errors

// ── MCP Idle Disconnect Timers ──────────────────────────────────────────────────
// Automatically disconnect backend processes (Node/Python) after 10m of inactivity
// to ensure idle agents don't consume gigabytes of background RAM.
const mcpIdleTimers = new Map<string, NodeJS.Timeout>();
const MCP_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function resetMcpIdleTimer(serverId: string, serverName: string) {
  const existing = mcpIdleTimers.get(serverId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    logMcpRenderer("info", `Disconnecting server ${serverName} due to ${MCP_IDLE_TIMEOUT_MS / 60000}m of inactivity...`, { serverId, serverName });
    try {
      await disconnectServer(serverId);
    } catch (err) {
      logMcpRenderer("warn", `Failed to idle-disconnect server ${serverName}`, { error: String(err) });
    }
  }, MCP_IDLE_TIMEOUT_MS);

  mcpIdleTimers.set(serverId, timer);
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown> | null | undefined
): Promise<{ result: unknown; error?: string }> {
  const startTime = Date.now();
  let safeArgs = ensureRecord(args);
  const sanitizedArgs = sanitizeArgsForLogging(safeArgs);
  const MAX_RETRIES = 1;

  logMcpRenderer("info", `Tool call initiated: ${toolName}`, {
    operation: "executeToolCall",
    toolName,
    args: sanitizedArgs,
    argsSize: JSON.stringify(safeArgs).length,
  });

  console.log(`[MCP Renderer] Invoking Tool: ${toolName}`, sanitizedArgs);

  // VALIDATION: convert_to_markdown requires an absolute URI or path.
  // Accepts: file:///absolute/path, /absolute/path, C:\absolute\path
  // Rejects: file://relative, bare-filename.ext (no leading slash or drive letter)
  if (toolName === 'convert_to_markdown') {
    const uri = (args?.uri || args?.path) as string | undefined;

    // Guard against completely empty URI (file.path was "" on the attachment)
    if (!uri || uri.trim() === '' || uri === 'file://' || uri === 'file:') {
      return {
        result: null,
        error: `PATH ERROR: URI is empty. The attached file did not expose a native filesystem path. ` +
          `Check the [ATTACHED FILES] block in this conversation for the exact uri= argument to use.`
      };
    }

    if (typeof uri === 'string') {
      // Accept: file:///absolute, file:// immediately followed by '/' (Unix), bare /absolute, C:\...
      // uri[7] must be '/' — catches file://filename (relative, no leading slash after //)
      // and file:// (empty path, caught above but doubled here for safety).
      const isAbsolute =
        uri.startsWith('file:///') ||
        uri.startsWith('file:////') ||
        (uri.startsWith('file://') && uri[7] === '/') ||
        uri.startsWith('/') ||
        !!uri.match(/^[a-zA-Z]:[\\/]/);

      const isRelativeFileUri =
        uri.startsWith('file:') &&
        !uri.startsWith('file:///') &&
        !uri.startsWith('file:////') &&
        !(uri.startsWith('file://') && uri[7] === '/');

      if (!isAbsolute || isRelativeFileUri) {
        return {
          result: null,
          error:
            `PATH ERROR: '${uri}' is not an absolute file URI. ` +
            `You must copy the uri= value CHARACTER-FOR-CHARACTER from the ` +
            `[ATTACHED FILES] block — do NOT reconstruct it from the filename alone. ` +
            `The correct format is: file:///Users/username/path/to/file.ext`
        };
      }
    }
  }


  if (toolName.startsWith('fs_')) {
    // Block filesystem access when BOTH conditions are true:
    //   (a) no workspace path has been set for this session, AND
    //   (b) the target path itself is not already absolute.
    // This allows: auto-set workspaces (from file attachment), absolute paths.
    // This blocks:  relative paths with no workspace context.
    const wsPath = args?.workspacePath as string | undefined;
    const targetPath = args?.path as string | undefined;
    const targetIsAbsolute =
      !!targetPath &&
      (targetPath.startsWith('/') || !!targetPath.match(/^[a-zA-Z]:[\\/]/));

    if (!wsPath && !targetIsAbsolute) {
      return {
        result: null,
        error: 'WORKSPACE REQUIRED: Please select a workspace folder using the folder icon in the UI before performing filesystem operations.'
      };
    }

    // Path traversal guard — only runs when a workspace boundary is defined.
    if (wsPath && targetPath) {
      const normalizedWs = wsPath.replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedTarget = targetPath.replace(/\\/g, '/');
      if (!normalizedTarget.startsWith(normalizedWs)) {
        return {
          result: null,
          error: `SECURITY VIOLATION: Access denied. Path '${targetPath}' is outside the active workspace '${wsPath}'.`
        };
      }
    }

    // Remove workspacePath from args before forwarding — tools don't expect it.
    if (args && 'workspacePath' in args) {
      delete (args as Record<string, unknown>).workspacePath;
    }
  }

  const policy = enforceToolCallPolicy(toolName, safeArgs);
  if (policy.action === "handled") {
    logMcpRenderer("warn", "Tool call handled by side-effect policy", {
      operation: "executeToolCall",
      toolName,
      result: policy.response.result,
      error: policy.response.error,
    });
    return policy.response;
  }
  if (policy.args) {
    safeArgs = policy.args;
  }

  // Built-in knowledge routes are daemon-owned in the browser even if a stale
  // Electron MCP schema is still present in persisted renderer state.
  const server = isBrowserProduct() && (toolName.startsWith('rag_') || toolName.startsWith('memory_')) ? null : findServerForTool(toolName);
  if (isBrowserProduct() && server) {
    try {
      const requestId = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `mcp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const result = await getBrowserAgentdClient().callMcpTool(server.id, toolName, safeArgs, requestId);
      return { result: result.result };
    } catch (error) {
      return { result: null, error: `Browser MCP tool call failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!server) {
    // FALLBACK: Check if it's an internal memory tool
    if (toolName.startsWith('memory_')) {
      logMcpRenderer("info", "Executing memory tool via direct IPC fallback", { tool: toolName });
      try {
        if (isBrowserProduct()) {
          const response = await getBrowserAgentdClient().callMemoryTool(toolName, safeArgs)
          return { result: response.result ?? null, ...(response.error ? { error: response.error } : {}) }
        }
        const result = await electron.memory.callTool(toolName, safeArgs)
        return { result: result.result ?? null, ...(result.error ? { error: result.error } : {}) };
      } catch (err) {
        return { result: null, error: `Direct memory tool call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // FALLBACK: Check if it's an internal WhatsApp tool
    if (toolName.startsWith('whatsapp_')) {
      if (isBrowserProduct()) {
        // Browser text sends use the authenticated agentd route directly. Do
        // not route generic tools through the Electron-shaped facade: media
        // tools carry native paths, and admin escalation is daemon-owned.
        if (toolName === 'whatsapp_send_message') {
          const targetJid = safeArgs?.to as string | undefined;
          const content = safeArgs?.content as string | undefined;
          if (!targetJid) return { result: null, error: "Missing 'to' parameter: Target WhatsApp number could not be resolved automatically." };
          if (!content?.trim()) return { result: null, error: "Missing 'content' parameter." };
          try {
            const result = await getBrowserAgentdClient().sendWhatsAppText(targetJid, content)
            return { result: 'Message sent successfully.', ...(result.duplicate ? { duplicate: true } : {}) }
          } catch (error) {
            return { result: null, error: `Browser WhatsApp send failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        }
        return {
          result: null,
          error: toolName === 'whatsapp_send_media'
            ? 'Browser WhatsApp media tools require the authenticated attachment route; native file-path tool calls are unavailable.'
            : 'Browser WhatsApp admin escalation is daemon-owned and is not exposed as a generic tool call.',
        }
      }

      logMcpRenderer("info", "Executing whatsapp tool via direct IPC fallback", { tool: toolName });
      try {
        const targetJid = safeArgs?.to as string | undefined;
        if (!targetJid) {
          return { result: null, error: "Missing 'to' parameter: Target WhatsApp number could not be resolved automatically." };
        }

        if (toolName === 'whatsapp_send_media') {
          const filePath = safeArgs?.filePath as string;
          if (!filePath) return { result: null, error: "Missing 'filePath' parameter." };
          
          const result = await electron.whatsapp.sendMediaMessage(
            targetJid,
            filePath,
            safeArgs?.caption as string | undefined,
            safeArgs?.type as string | undefined
          ) as { success: boolean; error?: string };
          
          if (result && result.error) return { result: null, error: result.error };
          return { result: "Media sent successfully." };
          
        } else if (toolName === 'whatsapp_send_message') {
          const content = safeArgs?.content as string;
          if (!content) return { result: null, error: "Missing 'content' parameter." };
          
          const result = await electron.whatsapp.sendMessage(targetJid, content) as { success: boolean; error?: string };
          
          if (result && result.error) return { result: null, error: result.error };
          return { result: "Message sent successfully." };
        } else if (toolName === 'whatsapp_notify_admin') {
          const summary = safeArgs?.summary as string;
          const mainQuestion = safeArgs?.mainQuestion as string;
          if (!summary || !mainQuestion) return { result: null, error: "Missing 'summary' or 'mainQuestion' parameters." };

          const result = await electron.whatsapp.notifyAdmin(targetJid, summary, mainQuestion) as { success: boolean; error?: string };
          if (result && result.error) return { result: null, error: result.error };
          return { result: "Admin has been notified. They will get back to the customer soon." };
        }
      } catch (err) {
        return { result: null, error: `Direct whatsapp tool call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

     // FALLBACK: Check if it's an internal RAG tool
     if (toolName.startsWith('rag_')) {
       logMcpRenderer("info", "Executing RAG tool via direct IPC fallback", { tool: toolName });
       try {
         if (isBrowserProduct()) {
           const client = getBrowserAgentdClient()
           if (toolName === 'rag_search') {
             if (typeof safeArgs.query !== 'string' || !safeArgs.query.trim()) return { result: [], error: "Missing 'query' parameter." }
             return { result: await client.searchKnowledge(safeArgs.query, typeof safeArgs.limit === 'number' ? safeArgs.limit : 5) }
           }
           if (toolName === 'rag_get_stats') {
             const documents = await client.listKnowledge()
             const fileTypes: Record<string, number> = {}
             let totalSize = 0
             for (const document of documents) {
               const extension = document.file_name.split('.').pop()?.toLowerCase() || 'unknown'
               fileTypes[extension] = (fileTypes[extension] || 0) + 1
               totalSize += document.size || 0
             }
             return { result: { count: documents.length, fileTypes, totalSize } }
           }
           if (toolName === 'rag_save_correction') {
             const question = typeof safeArgs.question === 'string' ? safeArgs.question.trim() : ''
             const answer = typeof safeArgs.answer === 'string' ? safeArgs.answer.trim() : ''
             if (!question || !answer) return { result: null, error: "Missing 'question' or 'answer' parameter." }
             const content = `Question: ${question}\nCorrect Answer: ${answer}`
             const now = Date.now()
             await client.ingestKnowledge({ fileName: `correction_${now}.txt`, filePath: `browser://correction/${now}`, fileType: 'text/plain', content, size: new TextEncoder().encode(content).byteLength })
             return { result: { success: true } }
           }
           return { result: null, error: `Browser knowledge tool '${toolName}' requires a file selected through the Knowledge UI.` }
         }
         // Find if we have an internal-rag server ID in the store to use, otherwise use default
         const result = await electron.mcp.callTool('internal-rag', toolName, safeArgs) as { result: unknown; error?: string };
         return result;
       } catch (err) {
         return { result: null, error: `Direct RAG tool call failed: ${err instanceof Error ? err.message : String(err)}` };
       }
     }

     // FALLBACK: Check if it's an internal email tool
     if (toolName.startsWith('email_')) {
       if (isBrowserProduct()) {
         return {
           result: null,
           error: 'Browser Email tool calls are disabled; the host applies the authenticated email policy and delivery route.',
         };
       }
       logMcpRenderer("info", "Executing email tool via direct IPC fallback", { tool: toolName });
       try {
         if (toolName === 'email_send_message') {
           const to = safeArgs?.to as string;
           const subject = safeArgs?.subject as string;
           const body = (safeArgs?.body || safeArgs?.content) as string;
           if (!to || !subject || !body) {
             return { result: null, error: "Missing 'to', 'subject', or 'body' parameter." };
           }
           const result = await electron.email.send({
             to,
             subject,
             body,
             inReplyTo: safeArgs?.inReplyTo as string | undefined,
             references: safeArgs?.references as string | undefined,
             accountName: safeArgs?.accountName as string | undefined,
           }) as { success: boolean; error?: string };
           if (!result.success) return { result: null, error: result.error || 'Email send failed' };
           return { result: 'Email sent successfully.' };
         }

         if (toolName === 'email_create_draft') {
           const from = (safeArgs?.from as string) || (safeArgs?.to as string) || 'unknown@example.com'
           const subject = (safeArgs?.subject as string) || '(No Subject)'
           const body = (safeArgs?.body || safeArgs?.content) as string
           if (!body) return { result: null, error: "Missing 'body' parameter." }
           const draft = createDraftResponse(
             body,
             {
               action: 'draft',
               confidence: 0.5,
               rationale: 'Draft created by tool call',
               hasSensitiveTopic: false,
               sensitiveTopics: [],
             },
             {
               from,
               subject,
               to: (safeArgs?.to as string) || from,
               inReplyTo: safeArgs?.inReplyTo as string | undefined,
               references: safeArgs?.references as string | undefined,
               accountName: safeArgs?.accountName as string | undefined,
             }
           )
           void useDraftStore.getState().addDraft(draft).catch(() => undefined)
           return { result: 'Draft created successfully.' }
         }

         // Fall back to currently connected MCP server implementation.
         const emailServer = useMcpStore.getState().servers.find((s) =>
           s.connected && s.tools.some((t) => t.name === toolName)
         )
         if (emailServer) {
           return await electron.mcp.callTool(emailServer.id, toolName, safeArgs) as { result: unknown; error?: string }
         }
         return { result: null, error: `No connected MCP server exposes tool '${toolName}'` }
       } catch (err) {
         return { result: null, error: `Direct email tool call failed: ${err instanceof Error ? err.message : String(err)}` };
       }
     }

    const duration = Date.now() - startTime;
    logMcpRenderer("error", "Tool not found in any connected server", {
      operation: "executeToolCall",
      toolName,
      duration,
    });

    return {
      result: null,
      error: `Tool ${toolName} not found in any connected server`,
    };
  }

  // LAZY CONNECT: If the server has the tool cached but is currently disconnected,
  // spin it up just-in-time before executing the tool.
  if (!server.connected) {
    logMcpRenderer("info", `Lazy connecting to server ${server.name} for tool ${toolName}...`, {
      operation: "lazyConnect",
      serverId: server.id,
      toolName
    });
    try {
      await connectServer(server.id);
      // Let the connection settle briefly just in case the server needs a moment to be ready
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      return {
        result: null,
        error: `Failed to lazy-connect to server ${server.name}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  // Reset idle timer for this server since it's actively being used
  resetMcpIdleTimer(server.id, server.name);

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = (await electron.mcp.callTool(server.id, toolName, safeArgs)) as {
        result: unknown;
        error?: string;
      };

      if (result.error) {
        const isConnectionClosed =
          result.error.includes("-32000") ||
          result.error.includes("Connection closed") ||
          result.error.includes("connection closed") ||
          result.error.includes("ECONNRESET") ||
          result.error.includes("EPIPE");

        if (isConnectionClosed) {
          lastError = result.error;
          useMcpStore.getState().updateServerState(server.id, {
            connected: false,
            tools: [],
            error: "Connection closed unexpectedly"
          });

          if (attempt < MAX_RETRIES) {
            try {
              await connectServer(server.id);
            } catch {
              // Ignore reconnection errors, we'll return the last error
            }
            continue; // Retry
          }
        }

        const duration = Date.now() - startTime;
        logMcpRenderer("error", "Tool call failed", {
          operation: "executeToolCall",
          toolName,
          serverId: server.id,
          error: result.error,
          duration,
        });
        return result;
      }

      // Success!
      const duration = Date.now() - startTime;
      // Avoid JSON.stringify just for logging — use cheap length estimate
      const resultSize = typeof result.result === 'string'
        ? result.result.length
        : (result.result ? '~object' : 0);

      logMcpRenderer("info", "Tool call completed successfully", {
        operation: "executeToolCall",
        toolName,
        serverId: server.id,
        duration,
        attempts: attempt + 1,
        resultSize,
      });
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Tool execution failed";
      lastError = errorMessage;

      if (attempt < MAX_RETRIES) {
        try {
          await connectServer(server.id);
        } catch {
          // Ignore reconnection errors
        }
        continue;
      }
    }
  }

  return {
    result: null,
    error: lastError || "Tool execution failed after retries",
  };
}

/**
 * Parses a tabId from a `new_tab` tool result.
 *
 * The MCP IPC layer wraps all in-process tool results in the standard MCP
 * content envelope: `{ result: { content: [{ type: 'text', text: '{"tabId":1}' }] } }`
 * This utility handles that format plus a raw-object fallback for robustness.
 *
 * @param toolResult - The raw result returned by `executeToolCall('new_tab', ...)`
 * @returns The numeric tabId, or undefined if it cannot be parsed.
 */
export function parseTabIdFromResult(toolResult: { result: unknown }): number | undefined {
  const resAny = toolResult.result as Record<string, unknown> | null | undefined;

  // Primary path: standard MCP content envelope
  if (resAny?.content && Array.isArray(resAny.content) && (resAny.content[0] as Record<string, unknown>)?.text) {
    try {
      const parsed = JSON.parse((resAny.content[0] as Record<string, unknown>).text as string);
      if (typeof parsed.tabId === 'number') return parsed.tabId;
    } catch {
      console.warn('[MCP] parseTabIdFromResult: failed to JSON-parse content[0].text:', (resAny.content[0] as Record<string, unknown>).text);
    }
  }

  // Fallback: tool returned raw object (e.g. in tests or non-wrapped contexts)
  if (typeof resAny?.tabId === 'number') return resAny.tabId;

  return undefined;
}

export async function setAutoConnect(serverId: string, enabled: boolean): Promise<void> {
  return useMcpStore.getState().setAutoConnect(serverId, enabled);
}

export async function initializeMcpServers(): Promise<void> {
  return useMcpStore.getState().initialize();
}
