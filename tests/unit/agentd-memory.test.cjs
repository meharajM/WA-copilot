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

test('agentd memory graph routes persist bounded entities, relations, search, and export', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-memory-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }

  assert.equal((await request(origin, 'GET', '/api/v1/memory/stats', undefined, {})).status, 401)
  const create = await request(origin, 'POST', '/api/v1/memory/tools', {
    name: 'memory_create_entity',
    args: { name: 'Northwind', type: 'project', description: 'Retail support project', observations: ['Uses agentd'], metadata: { region: 'EU' } },
  }, auth)
  assert.equal(create.status, 200)
  const entity = create.body.result
  assert.equal(entity.name, 'Northwind')
  const second = await request(origin, 'POST', '/api/v1/memory/tools', {
    name: 'memory_create_entity',
    args: { name: 'Support team', type: 'concept', description: 'Handles customer returns' },
  }, auth)
  assert.equal(second.status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/memory/tools', { name: 'memory_create_relation', args: { from_entity_id: entity.id, to_entity_id: second.body.result.id, relation_type: 'managed_by' } }, auth)).status, 200)
  const search = await request(origin, 'POST', '/api/v1/memory/tools', { name: 'memory_search', args: { query: 'returns', limit: 5 } }, auth)
  assert.equal(search.body.result[0].name, 'Support team')
  assert.equal((await request(origin, 'GET', '/api/v1/memory/stats', undefined, auth)).body.stats.entityCount, 2)
  assert.equal((await request(origin, 'GET', '/api/v1/memory/export', undefined, auth)).body.data.relations.length, 1)
  assert.equal((await request(origin, 'POST', '/api/v1/memory/tools', { name: 'memory_update_entity', args: { id: entity.id, observation: 'Browser UI is primary' } }, auth)).body.result.observations.length, 2)
  assert.equal((await request(origin, 'POST', '/api/v1/memory/tools', { name: 'memory_delete_entity', args: { id: second.body.result.id } }, auth)).body.result.deleted, true)
  assert.equal((await request(origin, 'POST', '/api/v1/memory/tools', { name: 'memory_create_entity', args: { name: 'Secret', type: 'test', description: 'x', metadata: { apiKey: 'must-not-store' } } }, auth)).status, 400)
  await server.stop()
  const restarted = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const recovered = await restarted.start()
  assert.equal((await request(recovered.origin, 'GET', '/api/v1/memory/stats', undefined, auth)).body.stats.entityCount, 1)
  await restarted.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
