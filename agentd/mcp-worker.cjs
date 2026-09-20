const path = require('node:path')
const crypto = require('node:crypto')
const { isPublicCredentialKey } = require('./keyring-credential-store.cjs')

const MCP_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const MCP_REQUEST_TIMEOUT_MS = 30 * 1000
const MCP_RATE_WINDOW_MS = 60 * 1000
const MCP_RATE_LIMIT = 60
const MCP_MAX_RESULT_BYTES = 256 * 1024
const MCP_MAX_TOOL_SCHEMA_BYTES = 128 * 1024
const MCP_MAX_ARGS_BYTES = 64 * 1024
const MCP_MAX_TOOL_NAME_LENGTH = 128
const MCP_MAX_TOOLS = 128
const MCP_ALLOWED_UVX_PACKAGES = new Set(['markitdown-mcp[all]', 'mcp-email-server==0.6.2'])
const MCP_DISALLOWED_TOOLS = new Set(['evaluate', 'browser_run_code'])

const MCP_LIFECYCLE = Object.freeze({
  runtime: 'agentd',
  management: 'available',
  execution: 'available',
  reason: 'Approved MCP servers run under the supervised agentd worker',
  transports: ['stdio', 'sse', 'http'],
  tools: ['connect', 'disconnect', 'listTools', 'callTool', 'cancel'],
})

const safeString = (value, maxLength) => typeof value === 'string' ? value.slice(0, maxLength) : ''

function boundedJson(value, maxBytes, label) {
  let serialized
  try {
    serialized = JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? String(child) : child)
  } catch {
    throw new Error(`${label} is not serializable`)
  }
  if (Buffer.byteLength(serialized || 'null', 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  try { return JSON.parse(serialized || 'null') } catch { throw new Error(`${label} is not valid JSON`) }
}

function parseHttpUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('MCP URL must use HTTP(S)') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP URL must use HTTP(S) without credentials or fragments')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('MCP HTTP URLs must use HTTPS unless they target loopback')
  }
  return url
}

function credentialKeyForEnv(envKey) {
  if (typeof envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envKey)) return null
  const exact = envKey.toLowerCase()
  if (isPublicCredentialKey(exact)) return exact
  return null
}

function validateServerConfig(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('Invalid MCP server configuration')
  if (typeof server.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(server.id)) throw new Error('Invalid MCP server ID')
  if (!['stdio', 'sse', 'http'].includes(server.type)) throw new Error('Unsupported MCP transport type')
  if (server.type === 'stdio') {
    if (server.command !== 'uvx') throw new Error('MCP stdio command is not approved')
    const args = Array.isArray(server.args) ? server.args : []
    if (!MCP_ALLOWED_UVX_PACKAGES.has(args[0])) throw new Error('MCP stdio package is not approved')
    if (args.some(arg => typeof arg !== 'string' || ['-e', '--eval', '-c', '--command', '--shell'].includes(arg))) throw new Error('MCP eval/command flags are not allowed')
  } else {
    parseHttpUrl(server.url)
    if (server.envKeys !== undefined && server.envKeys.length > 0) throw new Error('MCP environment credentials are supported only for stdio servers')
  }
  if (server.allowedTools !== undefined && (!Array.isArray(server.allowedTools) || server.allowedTools.length > MCP_MAX_TOOLS || server.allowedTools.some(tool => typeof tool !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(tool)))) throw new Error('Invalid MCP capability allowlist')
  if (server.envKeys !== undefined && (!Array.isArray(server.envKeys) || server.envKeys.length > 64 || server.envKeys.some(key => !credentialKeyForEnv(key)))) throw new Error('MCP environment keys must map to supported OS credentials')
  return server
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || typeof tool.name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(tool.name)) return null
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? boundedJson(tool.inputSchema, MCP_MAX_TOOL_SCHEMA_BYTES, 'MCP tool schema') : {}
  return {
    name: tool.name.slice(0, MCP_MAX_TOOL_NAME_LENGTH),
    description: safeString(tool.description, 4096),
    inputSchema,
  }
}

class McpWorker {
  constructor({ logger = console, credentials = null, sdk = null, now = () => Date.now(), requestTimeoutMs = MCP_REQUEST_TIMEOUT_MS } = {}) {
    this.logger = logger
    this.credentials = credentials
    this.sdk = sdk
    this.now = now
    this.requestTimeoutMs = requestTimeoutMs
    this.connections = new Map()
    this.connecting = new Map()
    this.connectionControllers = new Map()
    this.requests = new Map()
    this.rateBuckets = new Map()
    this.secretValues = new Set()
  }

  lifecycle() { return MCP_LIFECYCLE }

  async loadSdk() {
    if (this.sdk) return this.sdk
    // v1.x exposes Client through a package subpath but transport subpaths are
    // extensionless in its CommonJS export map. Resolve the installed CJS
    // client directory and load the transport files without bypassing package
    // version resolution.
    const clientEntry = require.resolve('@modelcontextprotocol/sdk/client')
    const clientDir = path.dirname(clientEntry)
    this.sdk = {
      Client: require('@modelcontextprotocol/sdk/client').Client,
      StdioClientTransport: require(path.join(clientDir, 'stdio.js')).StdioClientTransport,
      SSEClientTransport: require(path.join(clientDir, 'sse.js')).SSEClientTransport,
      StreamableHTTPClientTransport: require(path.join(clientDir, 'streamableHttp.js')).StreamableHTTPClientTransport,
    }
    return this.sdk
  }

  async resolveEnvironment(server) {
    const env = {}
    for (const envKey of server.envKeys || []) {
      const credentialKey = credentialKeyForEnv(envKey)
      if (!credentialKey || !this.credentials?.get) throw new Error('MCP environment credentials are unavailable')
      const value = await this.credentials.get(credentialKey)
      if (typeof value !== 'string' || !value) throw new Error(`Required MCP credential is not configured: ${credentialKey}`)
      this.secretValues.add(value)
      env[envKey] = value
    }
    return env
  }

  async createTransport(server) {
    const sdk = await this.loadSdk()
    if (server.type === 'stdio') {
      return new sdk.StdioClientTransport({
        command: server.command,
        args: Array.isArray(server.args) ? [...server.args] : [],
        env: await this.resolveEnvironment(server),
        stderr: 'pipe',
        maxBufferSize: MCP_MAX_RESULT_BYTES,
      })
    }
    const url = parseHttpUrl(server.url)
    return server.type === 'sse'
      ? new sdk.SSEClientTransport(url)
      : new sdk.StreamableHTTPClientTransport(url)
  }

  async connect(server) {
    validateServerConfig(server)
    const current = this.connections.get(server.id)
    if (current) {
      this.touch(current)
      return this.projectRuntime(server)
    }
    const pending = this.connecting.get(server.id)
    if (pending) return pending
    const operation = (async () => {
      const controller = new AbortController()
      this.connectionControllers.set(server.id, controller)
      let client = null
      let timer
      try {
        const clientSdk = await this.loadSdk()
        const transport = await this.createTransport(server)
        client = new clientSdk.Client({ name: 'aica-agentd', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MCP connection timed out')) }, this.requestTimeoutMs) })
        await Promise.race([client.connect(transport, { signal: controller.signal, timeout: this.requestTimeoutMs }), timeout])
        const toolsResult = await client.listTools({}, { signal: controller.signal, timeout: this.requestTimeoutMs })
        const tools = (Array.isArray(toolsResult?.tools) ? toolsResult.tools : []).map(normalizeTool).filter(Boolean).map(tool => this.redactSecrets(tool))
        if (tools.length !== (toolsResult?.tools || []).length) throw new Error('MCP server returned an invalid tool list')
        if (tools.length > MCP_MAX_TOOLS) throw new Error('MCP server returned too many tools')
        const record = { client, transport, server: { ...server }, tools, lastUsedAt: this.now(), idleTimer: null }
        this.touch(record)
        this.connections.set(server.id, record)
        return this.projectRuntime(server)
      } catch (error) {
        try { await client?.close() } catch {}
        throw this.safeError(error, 'MCP server connection failed')
      } finally {
        clearTimeout(timer)
        this.connectionControllers.delete(server.id)
      }
    })()
    this.connecting.set(server.id, operation)
    try { return await operation } finally { this.connecting.delete(server.id) }
  }

  touch(record) {
    clearTimeout(record.idleTimer)
    record.lastUsedAt = this.now()
    record.idleTimer = setTimeout(() => { void this.disconnect(record.server.id) }, MCP_IDLE_TIMEOUT_MS)
    record.idleTimer.unref?.()
  }

  redactSecrets(value) {
    if (typeof value === 'string') {
      return [...this.secretValues].reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, value)
    }
    if (Array.isArray(value)) return value.map(item => this.redactSecrets(item))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, this.redactSecrets(child)]))
  }

  safeError(error, fallback) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (!message || message.length > 512 || [...this.secretValues].some(secret => secret && message.includes(secret))) return new Error(fallback)
    return new Error(message)
  }

  projectRuntime(server) {
    const record = this.connections.get(server.id)
    return {
      id: server.id,
      name: server.name,
      description: server.description || '',
      type: server.type,
      ...(server.command !== undefined ? { command: server.command, args: server.args || [] } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      ...(server.allowedTools !== undefined ? { allowedTools: server.allowedTools } : {}),
      ...(server.envKeys !== undefined ? { envKeys: server.envKeys } : {}),
      execution: 'available',
      connected: Boolean(record),
      tools: record ? record.tools : [],
      autoConnect: Boolean(server.autoConnect),
    }
  }

  async disconnect(serverId) {
    const pending = this.connecting.get(serverId)
    const controller = this.connectionControllers.get(serverId)
    if (pending && controller) {
      controller.abort()
      try { await pending } catch {}
      return true
    }
    const record = this.connections.get(serverId)
    if (!record) return false
    this.connections.delete(serverId)
    clearTimeout(record.idleTimer)
    try { await record.client.close() } catch {}
    return true
  }

  listTools(server) {
    const record = this.connections.get(server.id)
    if (!record) throw new Error('MCP server is not connected')
    this.touch(record)
    return record.tools
  }

  checkRate(serverId) {
    const now = this.now()
    const entries = (this.rateBuckets.get(serverId) || []).filter(timestamp => now - timestamp < MCP_RATE_WINDOW_MS)
    if (entries.length >= MCP_RATE_LIMIT) throw new Error('MCP tool rate limit exceeded')
    entries.push(now)
    this.rateBuckets.set(serverId, entries)
  }

  async call(server, toolName, args = {}, requestId = crypto.randomUUID()) {
    validateServerConfig(server)
    if (typeof toolName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(toolName) || MCP_DISALLOWED_TOOLS.has(toolName)) throw new Error('MCP tool is not allowed')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP arguments must be an object')
    const argsValue = boundedJson(args, MCP_MAX_ARGS_BYTES, 'MCP arguments')
    if (server.allowedTools && !server.allowedTools.includes(toolName)) throw new Error('MCP tool is not in the server allowlist')
    this.checkRate(server.id)
    if (this.requests.has(requestId)) throw new Error('MCP request is already running')
    const record = this.connections.get(server.id) || (await this.connect(server), this.connections.get(server.id))
    if (!record) throw new Error('MCP server connection failed')
    const controller = new AbortController()
    const promise = (async () => {
      let timeout
      let timedOut = false
      try {
        const toolCall = record.client.callTool({ name: toolName, arguments: argsValue }, undefined, { signal: controller.signal, timeout: this.requestTimeoutMs })
        const deadline = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true
            controller.abort()
            reject(new Error('MCP tool call timed out'))
          }, this.requestTimeoutMs)
        })
        const result = await Promise.race([toolCall, deadline])
        const bounded = this.redactSecrets(boundedJson(result, MCP_MAX_RESULT_BYTES, 'MCP result'))
        this.touch(record)
        return bounded
      } catch (error) {
        if (timedOut) throw new Error('MCP tool call timed out')
        throw error
      } finally {
        clearTimeout(timeout)
        this.requests.delete(requestId)
      }
    })()
    this.requests.set(requestId, { controller, serverId: server.id, promise })
    try {
      return await promise
    } catch (error) {
      if (error instanceof Error && error.message === 'MCP tool call timed out') throw error
      if (controller.signal.aborted) throw new Error('MCP tool call cancelled')
      throw this.safeError(error, 'MCP tool call failed')
    }
  }

  async cancel(requestId) {
    const request = this.requests.get(requestId)
    if (!request) return false
    request.controller.abort()
    try { await request.promise } catch {}
    await this.disconnect(request.serverId)
    return true
  }

  async closeAll() {
    for (const controller of this.connectionControllers.values()) controller.abort()
    await Promise.all([...this.connecting.values()].map(operation => operation.catch(() => undefined)))
    for (const request of this.requests.values()) request.controller.abort()
    this.requests.clear()
    await Promise.all([...this.connections.keys()].map(serverId => this.disconnect(serverId)))
    this.connectionControllers.clear()
    this.connecting.clear()
    this.rateBuckets.clear()
    this.secretValues.clear()
  }
}

module.exports = {
  McpWorker,
  MCP_LIFECYCLE,
  MCP_IDLE_TIMEOUT_MS,
  MCP_REQUEST_TIMEOUT_MS,
  MCP_RATE_LIMIT,
  validateServerConfig,
  boundedJson,
}
