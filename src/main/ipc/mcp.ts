import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { PlaywrightService } from '../services/PlaywrightService'
import { MemoryService } from '../services/MemoryService'
import { RAGService } from '../rag/RAGService'
import { FileSystemService } from '../services/FileSystemService'
import { McpProcessManager } from '../services/McpProcessManager'
import { isMcpToolAllowed, validateMcpServerConfig, validateMcpToolCall } from '../services/McpPolicy'
import { recordMcpAudit } from '../services/McpAudit'
import { autonomyMcpService } from '../services/AutonomyMcpService'

// --- State ---
const activeConnections = new Map<string, Client>()
const inProcessPlaywrightConnections = new Set<string>()
const inProcessMemoryConnections = new Set<string>()
const inProcessRagConnections = new Set<string>()
const inProcessFilesystemConnections = new Set<string>()
const inProcessAutonomyConnections = new Set<string>()
const connectingServers = new Set<string>()
const serverAllowedTools = new Map<string, string[]>()
const requestControllers = new Map<string, { controller: AbortController; senderId: number }>()
const rateBuckets = new Map<string, number[]>()
const sessionTokens = new Map<number, string>()
const MCP_CALL_TIMEOUT_MS = 30_000

// --- Helpers ---

function isPlaywrightServer(serverConfig: { id?: string; name?: string; command?: string; args?: string[] }): boolean {
    const { id, name, command, args } = serverConfig
    const idOrName = (id || name || '').toLowerCase()
    const argsStr = (args || []).join(' ').toLowerCase()
    return idOrName.includes('playwright') || argsStr.includes('@playwright/mcp') || command === 'internal'
}

function logMcpOperation(level: 'info' | 'warn' | 'error', message: string, context: unknown): void {
    const timestamp = new Date().toISOString()
    const logMessage = `[MCP ${level.toUpperCase()}] ${timestamp} - ${message}`
    const contextStr = JSON.stringify(context, null, 2)

    switch (level) {
        case 'error': console.error(logMessage, '\nContext:', contextStr); break
        case 'warn': console.warn(logMessage, '\nContext:', contextStr); break
        default: console.log(logMessage, '\nContext:', contextStr); break
    }
}

function isConnectionClosedError(error: string | Error): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return errorMessage.includes('-32000') ||
        errorMessage.toLowerCase().includes('connection closed') ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('EPIPE')
}

function cleanupClosedConnection(serverId: string): void {
    const client = activeConnections.get(serverId)
    if (client) {
        client.close().catch(() => {})
        activeConnections.delete(serverId)
    }
    McpProcessManager.getInstance().unregisterProcess(serverId)
    serverAllowedTools.delete(serverId)
}

function sanitizeArgs(args: unknown): unknown {
    if (!args || typeof args !== 'object') return args
    const sanitized = { ...args as Record<string, unknown> }
    const sensitiveKeys = ['password', 'apiKey', 'token', 'secret', 'key', 'auth']

    for (const key in sanitized) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
            sanitized[key] = '***REDACTED***'
        } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
            sanitized[key] = sanitizeArgs(sanitized[key])
        }
    }
    return sanitized
}

async function withMcpTimeout<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const cancelled = new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('MCP tool call cancelled')), { once: true }))
    try {
        return await Promise.race([operation, cancelled, new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MCP tool call timed out')) }, MCP_CALL_TIMEOUT_MS) })])
    } finally { if (timer) clearTimeout(timer) }
}

function trustedRenderer(event: Electron.IpcMainInvokeEvent): boolean { return Boolean(BrowserWindow.fromWebContents(event.sender)) }
function authorizedRenderer(event: Electron.IpcMainInvokeEvent, token: unknown): boolean {
    return trustedRenderer(event) && typeof token === 'string' && sessionTokens.get(event.sender.id) === token
}
function consumeRateLimit(key: string): boolean {
    const recent = (rateBuckets.get(key) || []).filter(timestamp => timestamp > Date.now() - 60_000)
    if (recent.length >= 60) { rateBuckets.set(key, recent); return false }
    recent.push(Date.now()); rateBuckets.set(key, recent); return true
}

function toolNames(tools: { tools?: Array<{ name?: unknown }> }): string[] {
    return (tools.tools || []).map(tool => tool.name).filter((name): name is string => typeof name === 'string')
}

// --- IPC Register ---

export function registerMcpHandlers(): void {
    ipcMain.handle('mcp:authorize', async (event) => {
        if (!trustedRenderer(event)) return { success: false, error: 'Untrusted MCP caller' }
        const token = randomUUID(); sessionTokens.set(event.sender.id, token); return { success: true, token }
    })
    ipcMain.handle('mcp:connect', async (event, serverConfig, token?: unknown) => {
        if (!authorizedRenderer(event, token)) return { success: false, error: 'Unauthorized MCP session' }
        const startTime = Date.now()
        const validation = validateMcpServerConfig(serverConfig)
        if (!validation.valid) { recordMcpAudit('connect', null, null, 'denied', { error: validation.error }); return { success: false, error: validation.error } }
        serverConfig = validation.config
        const { id, type, command, args, url, env } = serverConfig
        serverAllowedTools.set(id, Array.isArray(serverConfig.allowedTools)
            ? serverConfig.allowedTools
            : (command === 'uvx' && args?.some((arg: string) => arg.includes('markitdown-mcp')) ? ['convert_to_markdown'] : []))

        logMcpOperation('info', 'MCP connection requested', {
            operation: 'connect',
            serverId: id,
            type, command, args: args?.join(' '),
            url: type === 'sse' ? url : undefined,
            hasEnv: !!env,
        })

        try {
            if (activeConnections.has(id)) {
                return { success: true, serverId: id }
            }

            if (connectingServers.has(id)) {
                // Return success if already connecting, SDK client will be available shortly
                return { success: true, serverId: id }
            }

            connectingServers.add(id)

            // In-process Playwright
            if (isPlaywrightServer(serverConfig)) {
                if (inProcessPlaywrightConnections.has(id)) return { success: true, serverId: id, inProcess: true }
                try {
                    const service = PlaywrightService.getInstance()
                    await service.initialize()
                    if (serverConfig.allowedTools === undefined) serverAllowedTools.set(id, toolNames(service.listTools()))
                    inProcessPlaywrightConnections.add(id)
                    logMcpOperation('info', 'In-process Playwright connection established', { operation: 'connect', serverId: id, inProcess: true })
                    return { success: true, serverId: id, inProcess: true }
                } catch (playwrightError: unknown) {
                    logMcpOperation('warn', 'In-process Playwright failed, falling back to external MCP', { operation: 'connect', serverId: id, error: String(playwrightError) })
                }
            }

            // In-process Memory
            if (command === 'internal-memory' || (args && args.includes('memory-service'))) {
                const service = MemoryService.getInstance()
                service.initialize()
                if (serverConfig.allowedTools === undefined) serverAllowedTools.set(id, toolNames(service.listTools()))
                inProcessMemoryConnections.add(id)
                logMcpOperation('info', 'In-process Memory connection established', { operation: 'connect', serverId: id, inProcess: true })
                return { success: true, serverId: id, inProcess: true }
            }

            // In-process RAG
            if (command === 'internal-rag' || (args && args.includes('rag-service'))) {
                if (serverConfig.allowedTools === undefined) serverAllowedTools.set(id, toolNames(RAGService.getInstance().listTools()))
                inProcessRagConnections.add(id)
                logMcpOperation('info', 'In-process RAG connection established', { operation: 'connect', serverId: id, inProcess: true })
                return { success: true, serverId: id, inProcess: true }
            }

            // In-process Filesystem
            if (command === 'internal-filesystem' || (args && args.includes('filesystem-service'))) {
                if (serverConfig.allowedTools === undefined) serverAllowedTools.set(id, toolNames(FileSystemService.getInstance().listTools()))
                inProcessFilesystemConnections.add(id)
                logMcpOperation('info', 'In-process Filesystem connection established', { operation: 'connect', serverId: id, inProcess: true })
                return { success: true, serverId: id, inProcess: true }
            }

            if (command === 'internal-autonomy') {
                inProcessAutonomyConnections.add(id)
                return { success: true, serverId: id, inProcess: true }
            }

            let transport: StdioClientTransport | SSEClientTransport

            if (type === 'stdio') {
                let finalCommand = command
                const finalEnv = { ...process.env, ...(env || {}) } as Record<string, string>

                if (command === 'node' || command === 'node.exe') {
                    finalCommand = process.execPath
                    finalEnv.ELECTRON_RUN_AS_NODE = '1'
                }

                transport = new StdioClientTransport({
                    command: finalCommand,
                    args: args || [],
                    env: finalEnv,
                    stderr: 'pipe'
                })

                // MODULAR CHANGE: Track process via Manager
                const transportWithProcess = transport as unknown as { _process?: import('child_process').ChildProcess }
                if (transportWithProcess._process) {
                    McpProcessManager.getInstance().registerProcess(id, transportWithProcess._process)
                }

                // Old-style process monitoring logic (Kept for compatibility/logs)
                if (transportWithProcess._process) {
                    const proc = transportWithProcess._process
                    proc.on('exit', (code) => {
                        if (code !== 0 && code !== null) {
                            cleanupClosedConnection(id)
                        }
                    })
                    proc.on('error', (err) => {
                        logMcpOperation('error', 'MCP process error', { operation: 'monitor', serverId: id, error: err.message })
                        cleanupClosedConnection(id)
                    })
                    if (proc.stderr) {
                        proc.stderr.on('data', (d: Buffer) => {
                            const s = d.toString().trim()
                            if (s) logMcpOperation('info', 'MCP stderr', { operation: 'stderr', serverId: id, stderr: s })
                        })
                    }
                    if (proc.stdin) {
                        proc.stdin.on('error', (err) => {
                            logMcpOperation('error', 'MCP stdin error', { operation: 'stdin', serverId: id, error: err.message })
                        })
                    }
                }
            } else if (type === 'sse' && url) {
                transport = new SSEClientTransport(new URL(url))
            } else {
                throw new Error(`Unsupported transport type: ${type}`)
            }

            const client = new Client({ name: "AIConsumerAgent-Client", version: "0.1.0" }, { capabilities: { sampling: {} } })
            await client.connect(transport)
            
            const duration = Date.now() - startTime
            logMcpOperation('info', 'MCP server connected', { operation: 'connect', serverId: id, duration })
            activeConnections.set(id, client)
            recordMcpAudit('connect', id, null, 'success', { transport: type })
            return { success: true, serverId: id }
        } catch (error: unknown) {
            const duration = Date.now() - startTime
            const msg = error instanceof Error ? error.message : String(error)
            logMcpOperation('error', 'MCP connection failed', { operation: 'connect', serverId: id, error: msg, duration })

            let det = msg
            if (msg.includes('ENOENT')) det = getInstallInstructions(command, args)
            cleanupClosedConnection(id)
            recordMcpAudit('connect', id || null, null, 'failure', { error: msg })
            return { success: false, error: det }
        } finally {
            connectingServers.delete(id)
        }
    })

    ipcMain.handle('mcp:disconnect', async (event, id: string, token?: unknown) => {
        if (!authorizedRenderer(event, token)) return { success: false, error: 'Unauthorized MCP session' }
        const startTime = Date.now()
        if (id === 'internal' || inProcessPlaywrightConnections.has(id)) {
            inProcessPlaywrightConnections.delete(id)
            serverAllowedTools.delete(id)
            return { success: true }
        }
        if (id === 'internal-memory' || inProcessMemoryConnections.has(id)) {
            inProcessMemoryConnections.delete(id)
            serverAllowedTools.delete(id)
            return { success: true }
        }
        if (id === 'internal-rag' || inProcessRagConnections.has(id)) {
            inProcessRagConnections.delete(id)
            serverAllowedTools.delete(id)
            return { success: true }
        }
        if (id === 'internal-filesystem' || inProcessFilesystemConnections.has(id)) {
            inProcessFilesystemConnections.delete(id)
            serverAllowedTools.delete(id)
            return { success: true }
        }
        if (id === 'internal-autonomy' || inProcessAutonomyConnections.has(id)) {
            inProcessAutonomyConnections.delete(id)
            serverAllowedTools.delete(id)
            return { success: true }
        }

        const client = activeConnections.get(id)
        if (client) {
            try {
                await client.close()
                cleanupClosedConnection(id)
                logMcpOperation('info', 'MCP disconnected', { operation: 'disconnect', serverId: id, duration: Date.now() - startTime })
                return { success: true }
            } catch (err) {
                cleanupClosedConnection(id)
                return { success: false, error: err instanceof Error ? err.message : String(err) }
            }
        }
        return { success: true }
    })

    ipcMain.handle('mcp:list-tools', async (event, id: string, token?: unknown) => {
        if (!authorizedRenderer(event, token)) return { tools: [], error: 'Unauthorized MCP session' }
        // Alias support for hardcoded service names
        if (id === 'internal' || inProcessPlaywrightConnections.has(id)) return { tools: PlaywrightService.getInstance().listTools().tools }
        if (id === 'internal-memory' || inProcessMemoryConnections.has(id)) return { tools: MemoryService.getInstance().listTools().tools }
        if (id === 'internal-rag' || inProcessRagConnections.has(id)) return { tools: RAGService.getInstance().listTools().tools }
        if (id === 'internal-filesystem' || inProcessFilesystemConnections.has(id)) return { tools: FileSystemService.getInstance().listTools().tools }
        if (id === 'internal-autonomy' || inProcessAutonomyConnections.has(id)) return autonomyMcpService.listTools()

        const client = activeConnections.get(id)
        if (!client) return { tools: [], error: `Server not connected: ${id}` }

        try {
            const res = await client.listTools()
            logMcpOperation('info', 'MCP tools listed', { operation: 'list-tools', serverId: id, count: res.tools?.length })
            return { tools: res.tools || [] }
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err))
            if (isConnectionClosedError(errorObj)) cleanupClosedConnection(id)
            return { tools: [], error: errorObj.message }
        }
    })

    ipcMain.handle('mcp:call-tool', async (event, id, toolName, args, requestId?: unknown, token?: unknown) => {
        if (!authorizedRenderer(event, token)) return { result: null, error: 'Unauthorized MCP session' }
        const startTime = Date.now()
        const validationError = validateMcpToolCall(id, toolName, args)
        if (validationError) { recordMcpAudit('call-tool', typeof id === 'string' ? id : null, typeof toolName === 'string' ? toolName : null, 'denied', { error: validationError }); return { result: null, error: validationError } }
        const bucketKey = `${id}:${toolName}`
        if (!consumeRateLimit(bucketKey)) { recordMcpAudit('call-tool', id, toolName, 'denied', { reason: 'rate_limit' }); return { result: null, error: 'MCP tool rate limit exceeded' } }
        const requestKey = typeof requestId === 'string' && requestId.length <= 100 ? requestId : `${bucketKey}:${startTime}`
        if (requestControllers.has(requestKey)) return { result: null, error: 'MCP request ID is already active' }
        const internalCall = id === 'internal' || inProcessPlaywrightConnections.has(id)
            ? () => PlaywrightService.getInstance().callTool(toolName, args)
            : id === 'internal-memory' || inProcessMemoryConnections.has(id)
                ? () => MemoryService.getInstance().callTool(toolName, args)
                : id === 'internal-rag' || inProcessRagConnections.has(id)
                    ? () => RAGService.getInstance().callTool(toolName, args)
                    : id === 'internal-filesystem' || inProcessFilesystemConnections.has(id)
                        ? () => FileSystemService.getInstance().callTool(toolName, args)
                        : id === 'internal-autonomy' || inProcessAutonomyConnections.has(id)
                            ? () => autonomyMcpService.callTool(toolName, args)
                        : null
        if (internalCall) {
            if (!isMcpToolAllowed(serverAllowedTools.get(id), toolName)) {
                recordMcpAudit('call-tool', id, toolName, 'denied', { reason: 'capability_allowlist', internal: true })
                return { result: null, error: 'MCP tool is not allowlisted for this server' }
            }
            const controller = new AbortController()
            if (typeof requestId === 'string') requestControllers.set(requestKey, { controller, senderId: event.sender.id })
            try {
                const res = await withMcpTimeout(internalCall(), controller)
                if (res.error) { recordMcpAudit('call-tool', id, toolName, 'failure', { error: res.error, durationMs: Date.now() - startTime }); return { result: null, error: res.error } }
                const text = typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2)
                recordMcpAudit('call-tool', id, toolName, 'success', { durationMs: Date.now() - startTime })
                return { result: { content: [{ type: 'text', text }] } }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                recordMcpAudit('call-tool', id, toolName, 'failure', { error: message, durationMs: Date.now() - startTime })
                return { result: null, error: message }
            } finally { requestControllers.delete(requestKey) }
        }

        const client = activeConnections.get(id)
        if (!client) return { result: null, error: 'Server not connected' }
        if (!isMcpToolAllowed(serverAllowedTools.get(id), toolName)) { recordMcpAudit('call-tool', id, toolName, 'denied', { reason: 'capability_allowlist' }); return { result: null, error: 'MCP tool is not allowlisted for this server' } }

        try {
            const finalArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args : { input: args }
            logMcpOperation('info', `Calling tool: ${toolName}`, { operation: 'call-tool', serverId: id, toolName, args: sanitizeArgs(finalArgs) })
            const controller = new AbortController()
            requestControllers.set(requestKey, { controller, senderId: event.sender.id })
            const res = await withMcpTimeout(client.callTool({ name: toolName, arguments: finalArgs || {} }, undefined, { signal: controller.signal, timeout: MCP_CALL_TIMEOUT_MS }), controller)
            recordMcpAudit('call-tool', id, toolName, 'success', { durationMs: Date.now() - startTime })
            return { result: res }
        } catch (err: unknown) {
            const errorObj = err instanceof Error ? err : new Error(String(err))
            if (isConnectionClosedError(errorObj)) cleanupClosedConnection(id)
            recordMcpAudit('call-tool', id, toolName, 'failure', { error: errorObj.message, durationMs: Date.now() - startTime })
            return { result: null, error: errorObj.message }
        } finally { requestControllers.delete(requestKey) }
    })

    ipcMain.handle('mcp:cancel-tool', async (event, requestId: unknown, token?: unknown) => {
        if (!authorizedRenderer(event, token) || typeof requestId !== 'string') return { success: false, error: 'Invalid MCP cancellation request' }
        const request = requestControllers.get(requestId)
        if (!request || request.senderId !== event.sender.id) return { success: false, error: 'MCP request is not active' }
        request.controller.abort(); recordMcpAudit('cancel-tool', null, null, 'success', { requestId }); return { success: true }
    })
}

function getInstallInstructions(cmd: string, args?: string[]): string {
    const isMac = process.platform === 'darwin'
    const isWin = process.platform === 'win32'

    const header = "### 🛠️ Environment Setup Needed\n\nIt looks like the command `" + cmd + "` isn't available on your system yet. Don't worry, you can fix this in a few steps:"
    const internalNodeTip = "\n\n💡 **Pro Tip:** This app has a built-in Node.js runtime. If you have a local script, you can simply use `node` as the command and it will work immediately!"

    if (cmd.includes('node') || cmd.includes('npx') || cmd.includes('npm')) {
        let steps = ""
        if (isMac) steps = "1. Open your **Terminal** app.\n2. Type `brew install node` and press Enter.\n3. *If you don't have Homebrew, download Node.js from [nodejs.org](https://nodejs.org).* "
        else if (isWin) steps = "1. Download and run the installer from [nodejs.org](https://nodejs.org).\n2. Follow the setup wizard and make sure 'Add to PATH' is checked.\n3. Restart the AIConsumerAgent app once finished."
        else steps = "1. Install Node.js using your system's package manager (e.g., `sudo apt install nodejs`)."

        return header + "\n\n" + steps + internalNodeTip
    }
    if (cmd.includes('python') || cmd.includes('pip')) {
        let steps = ""
        if (isMac) steps = "1. Open your **Terminal** app.\n2. Type `brew install python` and press Enter.\n3. **Note:** Try using `python3` as the command in settings if `python` fails."
        else if (isWin) steps = "1. Download Python from [python.org](https://www.python.org/downloads/).\n2. **Important:** Check the box that says 'Add Python to PATH' during installation."
        else steps = "1. Install Python 3 using your system's package manager (e.g., `sudo apt install python3`)."

        if (args?.some(a => a.includes('mcp-server-git') || a.includes('mcp_server_git'))) {
            steps += `\n\n4. Finally, install the Git tool by running: \`pip install mcp-server-git\``
        }

        return header + "\n\n" + steps
    }
    if (cmd.includes('uv')) {
        const installCmd = isWin ? 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' : 'curl -LsSf https://astral.sh/uv/install.sh | sh'
        let steps = `1. **Install Python 3** (required):\n`

        if (isMac) steps += `   \`brew install python\`\n`
        else if (isWin) steps += `   Download from [python.org](https://www.python.org/downloads/) and check 'Add to PATH'\n`
        else steps += `   \`sudo apt install python3\`\n`

        steps += `\n2. **Install uv** (Python package runner):\n   \`${installCmd}\`\n\n3. **Restart the AIConsumerAgent app**`

        if (args?.some(a => a.includes('mcp-server-git') || a.includes('mcp_server_git'))) {
            steps += `\n\n💡 **Quick Fix:** Use \`uvx mcp-server-git /path/to/your/repo\` to run without installing.`
        }

        if (args?.some(a => a.includes('markitdown'))) {
            steps += `\n\n📄 **MarkItDown** will be automatically available once uv is installed. It converts PDFs, Word docs, Excel, images, and audio files to Markdown!`
        }

        return `${header}\n\n${steps}`
    }

    return `${header}\n\nEnsure that \`${cmd}\` is installed and added to your system's environmental paths (PATH).`
}
