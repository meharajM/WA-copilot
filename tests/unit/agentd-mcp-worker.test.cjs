const assert = require('node:assert/strict')
const test = require('node:test')
const { McpWorker, validateServerConfig } = require('../../agentd/mcp-worker.cjs')

class FakeTransport {
  constructor(options) { this.options = options; this.closed = false }
  async close() { this.closed = true }
}

class FakeClient {
  static instances = []
  constructor() {
    this.closed = false
    this.tools = [{ name: 'lookup', description: 'Lookup data', inputSchema: { type: 'object' } }]
    this.calls = []
    FakeClient.instances.push(this)
  }
  async connect(transport) { this.transport = transport }
  async listTools() { return { tools: this.tools } }
  async callTool(params, _schema, options) {
    this.calls.push(params)
    if (params.name === 'wait') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000)
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
      })
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, args: params.arguments }) }] }
  }
  async close() { this.closed = true; await this.transport?.close?.() }
}

const sdk = {
  Client: FakeClient,
  StdioClientTransport: FakeTransport,
  SSEClientTransport: FakeTransport,
  StreamableHTTPClientTransport: FakeTransport,
}

const config = (overrides = {}) => ({
  id: 'mcp_safe',
  name: 'Safe server',
  description: 'test',
  type: 'stdio',
  command: 'uvx',
  args: ['markitdown-mcp[all]'],
  allowedTools: ['lookup'],
  autoConnect: false,
  ...overrides,
})

test('MCP policy accepts only approved transports and rejects unsafe process/URL configs', () => {
  assert.equal(validateServerConfig(config()).id, 'mcp_safe')
  assert.throws(() => validateServerConfig(config({ command: 'node' })), /not approved/)
  assert.throws(() => validateServerConfig(config({ args: ['markitdown-mcp[all]', '--eval'] })), /eval/)
  assert.throws(() => validateServerConfig(config({ envKeys: ['MCP_API_TOKEN'] })), /environment keys/)
  assert.throws(() => validateServerConfig(config({ type: 'http', command: undefined, url: 'http://remote.example/mcp' })), /HTTPS/)
  assert.throws(() => validateServerConfig(config({ type: 'http', command: undefined, url: 'https://remote.example/mcp', envKeys: ['OPENAI_API_KEY'] })), /only for stdio/)
  assert.equal(validateServerConfig(config({ type: 'http', command: undefined, url: 'http://127.0.0.1:8123/mcp' })).type, 'http')
})

test('MCP worker connects, lists tools, resolves OS credentials, and calls an allowlisted tool', async () => {
  FakeClient.instances.length = 0
  const worker = new McpWorker({ sdk, credentials: { get: async key => key === 'openai_api_key' ? 'secret-never-logged' : null }, logger: { warn() {} } })
  const server = config({ envKeys: ['OPENAI_API_KEY'] })
  const projection = await worker.connect(server)
  assert.equal(projection.connected, true)
  assert.deepEqual(projection.tools, [{ name: 'lookup', description: 'Lookup data', inputSchema: { type: 'object' } }])
  assert.equal(FakeClient.instances[0].transport.options.env.OPENAI_API_KEY, 'secret-never-logged')
  const result = await worker.call(server, 'lookup', { q: 'hello' }, 'request-1')
  assert.deepEqual(result, { content: [{ type: 'text', text: JSON.stringify({ ok: true, args: { q: 'hello' } }) }] })
  const redacted = await worker.call(server, 'lookup', { q: 'secret-never-logged' }, 'request-2')
  assert.equal(redacted.content[0].text.includes('secret-never-logged'), false)
  assert.equal(redacted.content[0].text.includes('[REDACTED]'), true)
  await assert.rejects(() => worker.call(server, 'other', {}), /allowlist/)
  await assert.rejects(() => worker.call(server, 'lookup', []), /arguments must be an object/)
  await worker.disconnect(server.id)
  assert.equal(FakeClient.instances[0].closed, true)
})

test('MCP worker supports HTTP/SSE transports and rate limits calls', async () => {
  const worker = new McpWorker({ sdk, logger: { warn() {} } })
  for (const type of ['sse', 'http']) {
    const server = config({ id: `mcp_${type}`, type, command: undefined, args: undefined, url: type === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp' })
    const projection = await worker.connect(server)
    assert.equal(projection.connected, true)
    await worker.disconnect(server.id)
  }
  const server = config()
  await worker.connect(server)
  for (let index = 0; index < 60; index += 1) await worker.call(server, 'lookup', {}, `rate-${index}`)
  await assert.rejects(() => worker.call(server, 'lookup', {}, 'rate-over'), /rate limit/)
  await worker.closeAll()
})

test('MCP worker cancellation aborts the request and closes the supervised connection', async () => {
  const worker = new McpWorker({ sdk, requestTimeoutMs: 1000, logger: { warn() {} } })
  const server = config({ allowedTools: ['wait'] })
  await worker.connect(server)
  const pending = worker.call(server, 'wait', {}, 'cancel-me')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await worker.cancel('cancel-me'), true)
  await assert.rejects(() => pending, /cancelled/)
  assert.equal(await worker.cancel('missing'), false)
})

test('MCP worker cancels a connection that is still starting', async () => {
  let aborted = false
  const slowSdk = {
    ...sdk,
    Client: class extends FakeClient {
      async connect(_transport, options) {
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
        })
      }
    },
  }
  const worker = new McpWorker({ sdk: slowSdk, requestTimeoutMs: 1000, logger: { warn() {} } })
  const pending = worker.connect(config({ id: 'mcp_slow' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await worker.disconnect('mcp_slow'), true)
  await assert.rejects(() => pending)
  assert.equal(aborted, true)
  await worker.closeAll()
})

test('MCP worker times out calls and closes all children', async () => {
  const worker = new McpWorker({ sdk, requestTimeoutMs: 10, logger: { warn() {} } })
  const server = config({ allowedTools: ['wait'] })
  await assert.rejects(() => worker.call(server, 'wait', {}, 'timeout-me'), /timed out|cancelled/)
  await worker.closeAll()
})
