const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')
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

test('agentd never executes a browser WebGPU preference server-side', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-browser-')
  const secret = 'w'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ openrouter_api_key: 'must-not-be-used' }),
    providerFetch: async url => {
      calls.push(url)
      return providerResponse('should not run')
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'browser-provider' }, auth)).status, 201)
  const settings = {
    preferredProvider: 'browser',
    openaiModel: 'gpt-4o-mini',
    geminiModel: 'gemini-2.5-flash',
    openrouterModel: 'openai/gpt-4o',
  }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', settings, auth)).status, 200)
  const result = await request(origin, 'POST', '/api/v1/sessions/browser-provider/generations', { requestId: 'browser-r1', content: 'hello' }, auth)
  assert.equal(result.status, 503)
  assert.deepEqual(result.body, { error: 'Provider unavailable' })
  assert.deepEqual(calls, [])
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('generation admission fences provider discovery and leaves no orphan message during migration', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-admission-')
  const secret = 'm'.repeat(32)
  let credentialStarted
  const credentialEntered = new Promise(resolve => { credentialStarted = resolve })
  let releaseCredential
  const credentialRelease = new Promise(resolve => { releaseCredential = resolve })
  let providerCalled = false
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: {
      async get() {
        credentialStarted()
        await credentialRelease
        return 'provider-secret'
      },
    },
    providerFetch: async () => {
      providerCalled = true
      return providerResponse('should not run')
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'admit1' }, auth)).status, 201)
  const generation = request(origin, 'POST', '/api/v1/sessions/admit1/generations', { requestId: 'admit-r1', content: 'hello' }, auth)
  await credentialEntered
  assert.equal(server.activeOperations.size, 1)
  server.migrationHold = true
  server.migrationOwner = true
  let drained = false
  const drain = server.drainActiveOperations().then(() => { drained = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(drained, false)
  releaseCredential()
  const result = await generation
  assert.equal(result.status, 409)
  await drain
  assert.equal(drained, true)
  assert.equal(providerCalled, false)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get('admit1').count, 0)
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM chat_generations WHERE session_id = ?').get('admit1').count, 0)
  server.migrationHold = false
  server.migrationOwner = false
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

test('agentd routes browser generation to a local Ollama loopback service without credentials', async () => {
  const dataDir = makeTempDir('aica-agentd-ollama-')
  const secret = 'o'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials(),
    providerFetch: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions')
      assert.equal(options.headers.authorization, undefined)
      return providerResponse('local answer')
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/ollama', { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' }, auth)).status, 200)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { preferredProvider: 'ollama', openaiModel: 'gpt-4o-mini', geminiModel: 'gemini-2.5-flash', openrouterModel: 'anthropic/claude-3-haiku' }, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'ollama1', title: 'Local' }, auth)).status, 201)
  const generated = await request(origin, 'POST', '/api/v1/sessions/ollama1/generations', { requestId: 'ollama-r1', content: 'hello local' }, auth)
  assert.equal(generated.status, 200)
  assert.equal(generated.body.generation.provider, 'ollama')
  assert.equal(generated.body.message.content, 'local answer')
  assert.equal(calls.filter(call => call.url.endsWith('/api/tags')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/v1/chat/completions')).length, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd routes browser generation to Gemini with a fixed endpoint and native request shape', async () => {
  const dataDir = makeTempDir('aica-agentd-gemini-')
  const secret = 'g'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ gemini_api_key: 'gemini-secret' }),
    providerFetch: async (url, options) => {
      calls.push({ url, options })
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
      assert.equal(options.headers['x-goog-api-key'], 'gemini-secret')
      assert.equal(options.headers.authorization, undefined)
      const body = JSON.parse(options.body)
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hello Gemini' }] }])
      assert.deepEqual(body.generationConfig, { maxOutputTokens: 1024 })
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { preferredProvider: 'gemini', openaiModel: 'gpt-4o-mini', geminiModel: 'gemini-2.5-flash', openrouterModel: 'anthropic/claude-3-haiku' }, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'gemini1', title: 'Gemini' }, auth)).status, 201)
  const generated = await request(origin, 'POST', '/api/v1/sessions/gemini1/generations', { requestId: 'gemini-r1', content: 'hello Gemini' }, auth)
  assert.equal(generated.status, 200)
  assert.equal(generated.body.generation.provider, 'gemini')
  assert.equal(generated.body.message.content, 'Gemini answer')
  assert.equal(calls.length, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd streams Gemini SSE text deltas and persists the answer', async () => {
  const dataDir = makeTempDir('aica-agentd-gemini-stream-')
  const secret = 'k'.repeat(32)
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    credentials: credentials({ gemini_api_key: 'gemini-stream-secret' }),
    providerFetch: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
      assert.equal(options.headers['x-goog-api-key'], 'gemini-stream-secret')
      return new Response([
        'data: {"candidates":[{"content":{"parts":[{"text":"part one"}]}}]}',
        '',
        'data: {"candidates":[{"content":{"parts":[{"text":" part two"}]}}]}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}`, accept: 'text/event-stream' }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { preferredProvider: 'gemini', openaiModel: 'gpt-4o-mini', geminiModel: 'gemini-2.5-flash', openrouterModel: 'anthropic/claude-3-haiku' }, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/sessions', { id: 'gemini-stream', title: 'Gemini stream' }, auth)).status, 201)
  const streamed = await rawRequest(origin, 'POST', '/api/v1/sessions/gemini-stream/generations', { requestId: 'gemini-stream-r1', content: 'stream this' }, auth)
  assert.equal(streamed.status, 200)
  const events = streamed.text.split(/\n\n/).filter(Boolean).map(chunk => JSON.parse(chunk.replace(/^data: /, '')))
  assert.deepEqual(events.map(event => event.type), ['assistant.delta', 'assistant.delta', 'assistant.done'])
  assert.deepEqual(events.slice(0, 2).map(event => event.delta), ['part one', ' part two'])
  const history = await request(origin, 'GET', '/api/v1/sessions/gemini-stream', undefined, { authorization: `Bearer ${secret}` })
  assert.equal(history.body.messages.at(-1).content, 'part one part two')
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd keeps Ollama configuration loopback-only and exposes safe model discovery', async () => {
  const dataDir = makeTempDir('aica-agentd-ollama-settings-')
  const secret = 'p'.repeat(32)
  const server = new AgentdServer({
    dataDir,
    secret,
    logger: { log() {} },
    providerFetch: async url => {
      assert.equal(url, 'http://localhost:11434/api/tags')
      return new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }, { name: 'bad model\nname' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/ollama', { baseUrl: 'https://evil.example', model: 'llama3.2:3b' }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/ollama', { baseUrl: 'http://localhost:11434', model: 'llama3.2:3b' }, auth)).status, 200)
  const tested = await request(origin, 'POST', '/api/v1/providers/ollama/test', {}, auth)
  assert.deepEqual(tested.body, { success: true, modelCount: 1, models: ['llama3.2:3b'] })
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd upgrades legacy generation rows without losing provider history', async () => {
  const dataDir = makeTempDir('aica-agentd-generation-legacy-')
  const legacy = new Database(path.join(dataDir, 'agentd.db'))
  legacy.exec(`CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO chat_sessions VALUES ('legacy', 'Legacy chat', 10, 20);
  CREATE TABLE chat_generations (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter')),
    assistant_message_id TEXT,
    response_text TEXT,
    status TEXT NOT NULL CHECK(status IN ('processing','completed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO chat_generations VALUES ('legacy-r1', 'legacy', 'gpt-4o-mini', 'openai', 'assistant_legacy-r1', 'legacy answer', 'completed', 30, 40);`)
  legacy.close()

  const server = new AgentdServer({ dataDir, secret: 'm'.repeat(32), logger: { log() {} } })
  await server.start()
  const db = new Database(path.join(dataDir, 'agentd.db'), { readonly: true })
  const row = db.prepare('SELECT request_id,provider,response_text FROM chat_generations WHERE request_id = ?').get('legacy-r1')
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_generations'").get().sql
  db.close()
  assert.deepEqual(row, { request_id: 'legacy-r1', provider: 'openai', response_text: 'legacy answer' })
  assert.match(schema, /ollama/)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
