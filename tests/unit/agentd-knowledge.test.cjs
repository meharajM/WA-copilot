const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')

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
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-knowledge-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }

  assert.equal((await request(origin, 'GET', '/api/v1/knowledge', undefined, {})).status, 401)
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
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-knowledge-bounds-')
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
