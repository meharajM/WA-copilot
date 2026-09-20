const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('agentd persists bounded browser knowledge, searches it, and records accuracy', async () => {
  const dataDir = makeTempDir('aica-agentd-knowledge-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }

  assert.equal((await request(origin, 'GET', '/api/v1/knowledge', undefined, {})).status, 401)
  assert.equal((await request(origin, 'GET', '/api/v1/intelligence/stats', undefined, auth)).body.stats.autonomyRate, 0)
  const ingest = await request(origin, 'POST', '/api/v1/knowledge', {
    fileName: 'refunds.md',
    filePath: 'browser://knowledge/refunds.md',
    fileType: 'text/markdown',
    content: '# Refunds\nCustomers may request refunds within 30 days.',
    size: 55,
  }, auth)
  assert.equal(ingest.status, 201)
  assert.equal(ingest.body.document.file_name, 'refunds.md')
  assert.equal((await request(origin, 'GET', '/api/v1/knowledge/search?query=refunds&limit=3', undefined, auth)).body.results[0].content.includes('30 days'), true)
  assert.equal((await request(origin, 'POST', '/api/v1/intelligence/accuracy', { event: 'resolved', details: 'refund test' }, auth)).body.success, true)
  assert.equal((await request(origin, 'GET', '/api/v1/intelligence/stats', undefined, auth)).body.stats.resolvedQueries, 1)
  assert.equal((await request(origin, 'GET', '/api/v1/intelligence/logs?limit=5', undefined, auth)).body.logs.some(log => log.event === 'resolved'), true)
  const id = ingest.body.document.id
  assert.equal((await request(origin, 'DELETE', `/api/v1/knowledge/${id}`, undefined, auth)).body.deleted, true)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/knowledge', undefined, auth)).body.documents, [])
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd rejects unbounded or malformed browser knowledge', async () => {
  const dataDir = makeTempDir('aica-agentd-knowledge-bounds-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const base = { fileName: 'bad.txt', filePath: 'browser://bad', fileType: 'text/plain', content: 'x', size: 1 }
  assert.equal((await request(origin, 'POST', '/api/v1/knowledge', { ...base, unknown: 'secret' }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/knowledge', { ...base, content: 'x'.repeat(512 * 1024 + 1), size: 512 * 1024 + 1 }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/intelligence/accuracy', { event: 'bad event' }, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd converts bounded browser binary knowledge through the supervised converter', async () => {
  const dataDir = makeTempDir('aica-agentd-knowledge-convert-')
  const calls = []
  const worker = {
    async call(server, toolName, args) {
      calls.push({ server, toolName, args })
      const sourcePath = new URL(args.uri)
      assert.equal(sourcePath.protocol, 'file:')
      assert.equal(sourcePath.pathname.endsWith('/source.pdf'), true)
      assert.equal(fs.existsSync(sourcePath), true)
      assert.equal(fs.readFileSync(sourcePath).toString(), 'fake pdf bytes')
      return { content: [{ type: 'text', text: '# Converted document\n\nRefunds are allowed.' }] }
    },
    async closeAll() {},
    lifecycle() { return { runtime: 'agentd', management: 'available', execution: 'available', reason: 'test', transports: [], tools: [] } },
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {}, warn() {} }, mcpWorker: worker })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const source = Buffer.from('fake pdf bytes')
  assert.equal((await request(origin, 'POST', '/api/v1/knowledge/convert', {}, {})).status, 401)
  const converted = await request(origin, 'POST', '/api/v1/knowledge/convert', {
    fileName: 'refunds.pdf',
    fileType: 'application/pdf',
    dataBase64: source.toString('base64'),
    size: source.length,
  }, auth)
  assert.equal(converted.status, 201)
  assert.equal(converted.body.document.file_name, 'refunds.pdf')
  assert.equal(converted.body.document.file_type, 'text/markdown')
  assert.equal(converted.body.document.size, source.length)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].server.id, 'builtin_markitdown')
  assert.equal(calls[0].toolName, 'convert_to_markdown')
  assert.equal(calls[0].args.uri.startsWith('file://'), true)
  assert.deepEqual(server.db.prepare('SELECT file_name, content, size FROM knowledge_documents').all(), [{ file_name: 'refunds.pdf', content: '# Converted document\n\nRefunds are allowed.', size: source.length }])
  assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('.knowledge-conversion-')), false)
  assert.equal((await request(origin, 'POST', '/api/v1/knowledge/convert', { fileName: 'bad.pdf', fileType: 'application/pdf', dataBase64: 'bm90LW1hdGNo', size: 99 }, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd fails closed when supervised browser knowledge conversion fails', async () => {
  const dataDir = makeTempDir('aica-agentd-knowledge-convert-fail-')
  const worker = {
    async call() { throw new Error('converter failed with a native path') },
    async closeAll() {},
    lifecycle() { return { runtime: 'agentd', management: 'available', execution: 'available', reason: 'test', transports: [], tools: [] } },
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {}, warn() {} }, mcpWorker: worker })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const source = Buffer.from('unsupported')
  const response = await request(origin, 'POST', '/api/v1/knowledge/convert', {
    fileName: 'unsupported.docx',
    fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    dataBase64: source.toString('base64'),
    size: source.length,
  }, auth)
  assert.equal(response.status, 422)
  assert.deepEqual(response.body, { error: 'Knowledge conversion failed for this file' })
  assert.deepEqual(server.db.prepare('SELECT COUNT(*) AS count FROM knowledge_documents').get(), { count: 0 })
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
