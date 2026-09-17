const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, {
      method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function rawRequest(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, {
      method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function credentials(values = {}) {
  return {
    async get(key) { return values[key] ?? null },
    async exists(key) { return Boolean(values[key]) },
  }
}

function providerResponse(content = 'safe answer') {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('agentd generation is authenticated, bounded, fixed-endpoint, persisted, and idempotent', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-')
  const secret = 'g'.repeat(32)
  const calls = []
  const credentialValues = { openai_api_key: 'provider-secret' }
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials(credentialValues),
    providerFetch: async (url, options) => {
      calls.push({ url, options })
      return providerResponse('answer without secret')
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1', content: 'hello' })).status, 401)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations/r1/cancel', {})).status, 401)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/missing/generations', { requestId: 'r1', content: 'hello' }, auth)).status, 404)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 's1', title: 'Chat' }, auth)).status, 201)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1', content: 'hello', model: ' ' }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1-control', content: 'hello', model: 'gpt-4o\nmini' }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1-unicode', content: 'hello', model: '模型' }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1', content: 'hello', providerUrl: 'https://evil.example' }, auth)).status, 400)

  const generated = await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1', content: 'hello' }, auth)
  assert.equal(generated.status, 200)
  assert.equal(generated.body.generation.streaming, false)
  assert.equal(generated.body.generation.provider, 'openai')
  assert.equal(generated.body.message.content, 'answer without secret')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(calls[0].options.headers.authorization, 'Bearer provider-secret')
  assert.equal(JSON.parse(calls[0].options.body).stream, false)

  credentialValues.openai_api_key = null
  const duplicate = await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1', content: 'hello' }, auth)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.generation.duplicate, true)
  assert.equal(calls.length, 1)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s1/generations', { requestId: 'r1', content: 'changed' }, auth)).status, 409)
  const history = await request(origin, 'GET', '/api/v1/sessions/s1', undefined, auth)
  assert.deepEqual(history.body.messages.map(message => [message.role, message.content]), [['user', 'hello'], ['assistant', 'answer without secret']])

  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd generation returns safe errors and never accepts arbitrary provider URLs', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-error-')
  const secret = 'h'.repeat(32)
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ openrouter_api_key: 'router-secret' }),
    providerFetch: async url => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      return new Response(JSON.stringify({ error: { message: 'upstream secret should not escape' } }), { status: 500 })
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 's2' }, auth)).status, 201)
  const failed = await request(origin, 'POST', '/api/v1/sessions/s2/generations', { requestId: 'r2', content: 'hello' }, auth)
  assert.equal(failed.status, 502)
  assert.deepEqual(failed.body, { error: 'Provider generation failed' })
  assert.equal(JSON.stringify(failed.body).includes('upstream secret'), false)
  const retry = await request(origin, 'POST', '/api/v1/sessions/s2/generations', { requestId: 'r2', content: 'hello', model: 'anthropic/claude-3-haiku' }, auth)
  assert.equal(retry.status, 502)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd persists bounded browser attachments and maps text/images into provider content parts', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-attachments-')
  const secret = 'a'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ openai_api_key: 'provider-secret' }),
    providerFetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return providerResponse('attachment answer') },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 's3', title: 'Attachments' }, auth)).status, 201)
  const attachments = [
    { name: 'notes.txt', type: 'text/plain', size: 5, text: 'hello' },
    { name: 'pixel.png', type: 'image/png', size: 4, dataUrl: 'data:image/png;base64,AAAA' },
  ]
  const generated = await request(origin, 'POST', '/api/v1/sessions/s3/generations', { requestId: 'r3', content: 'Review these', attachments }, auth)
  assert.equal(generated.status, 200)
  const userMessage = calls[0].messages[0]
  assert.equal(Array.isArray(userMessage.content), true)
  assert.equal(userMessage.content.some(part => part.type === 'text' && part.text.includes('hello')), true)
  assert.equal(userMessage.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png')), true)
  const history = await request(origin, 'GET', '/api/v1/sessions/s3', undefined, auth)
  assert.deepEqual(history.body.messages[0].attachments, attachments)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 's4', title: 'Workspace', workspacePath: 'browser://workspace/Support' }, auth)).status, 201)
  assert.equal((await request(origin, 'GET', '/api/v1/sessions/s4', undefined, auth)).body.session.workspacePath, 'browser://workspace/Support')
  assert.equal((await request(origin, 'PATCH', '/api/v1/sessions/s4', { workspacePath: 'browser://workspace/Updated' }, auth)).body.session.workspacePath, 'browser://workspace/Updated')
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s3/generations', { requestId: 'invalid-attachment', content: 'x', attachments: [{ name: 'x.txt', type: 'text/plain', size: 1, dataUrl: 'not-a-data-url' }] }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions/s3/generations', { requestId: 'invalid-empty-attachment', content: '', attachments: [{ name: 'x.txt', type: 'text/plain', size: 1, dataUrl: 'not-a-data-url' }] }, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd streams provider deltas over authenticated SSE and persists the completed answer', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-stream-')
  const secret = 's'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ openai_api_key: 'provider-secret' }),
    providerFetch: async (_url, options) => {
      calls.push({ options })
      assert.equal(JSON.parse(options.body).stream, true)
      return new Response([
        'data: {"choices":[{"delta":{"content":"part one"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" part two"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}`, accept: 'text/event-stream' }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'stream1', title: 'Stream' }, auth)).status, 201)
  const streamed = await rawRequest(origin, 'POST', '/api/v1/sessions/stream1/generations', { requestId: 'stream-r1', content: 'hello' }, auth)
  assert.equal(streamed.status, 200)
  assert.equal(streamed.headers['content-type'], 'text/event-stream; charset=utf-8')
  const events = streamed.text.split(/\n\n/).filter(Boolean).map(chunk => JSON.parse(chunk.replace(/^data: /, '')))
  assert.deepEqual(events.map(event => event.type), ['assistant.delta', 'assistant.delta', 'assistant.done'])
  assert.deepEqual(events.slice(0, 2).map(event => event.delta), ['part one', ' part two'])
  assert.equal(calls.length, 1)
  const history = await request(origin, 'GET', '/api/v1/sessions/stream1', undefined, { authorization: `Bearer ${secret}` })
  assert.equal(history.body.messages.at(-1).content, 'part one part two')
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd aborts provider work on browser cancellation and allows retry', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-cancel-')
  const secret = 'c'.repeat(32)
  let callCount = 0
  let providerAborted = false
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ openai_api_key: 'provider-secret' }),
    providerFetch: async (_url, options) => {
      callCount += 1
      if (callCount === 1) {
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) return resolve()
          options.signal.addEventListener('abort', () => { providerAborted = true; reject(new Error('aborted')) }, { once: true })
        })
        throw new Error('aborted')
      }
      return new Response('data: {"choices":[{"delta":{"content":"retry answer"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}`, accept: 'text/event-stream' }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'cancel1', title: 'Cancel' }, auth)).status, 201)
  const generation = rawRequest(origin, 'POST', '/api/v1/sessions/cancel1/generations', { requestId: 'cancel-r1', content: 'hello' }, auth)
  await new Promise(resolve => setTimeout(resolve, 25))
  const cancelled = await request(origin, 'POST', '/api/v1/sessions/cancel1/generations/cancel-r1/cancel', {}, auth)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.cancelled, true)
  const cancelledResponse = await generation
  assert.equal(cancelledResponse.status, 200)
  assert.equal(cancelledResponse.text.includes('Provider generation failed'), true)
  assert.equal(providerAborted, true)
  const retry = await rawRequest(origin, 'POST', '/api/v1/sessions/cancel1/generations', { requestId: 'cancel-r1', content: 'hello' }, auth)
  assert.equal(retry.status, 200)
  assert.equal(retry.text.includes('retry answer'), true)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
