#!/usr/bin/env node

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')
const { AgentdServer } = require('../agentd/server.cjs')

const repoRoot = path.resolve(__dirname, '..')
const uiRoot = path.join(repoRoot, 'dist')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-browser-e2e-'))
const dataDir = path.join(tempRoot, 'agentd')

async function run() {
  assert.equal(fs.existsSync(path.join(uiRoot, 'tauri.html')), true, 'Missing browser bundle; run npm run build:tauri:web first')
  const server = new AgentdServer({
    dataDir,
    secret: 'browser-e2e-secret-'.padEnd(32, 'x'),
    pairingCode: '123456',
    uiRoot,
    logger: { log() {}, warn() {} },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const started = await server.start()
    const origin = started.origin
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))

    await page.goto(`${origin}/tauri.html`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Pair this browser' }).waitFor()
    await page.getByLabel('Pairing code').fill('123456')
    await page.getByRole('button', { name: 'Pair browser' }).click()
    await page.getByRole('button', { name: 'Command Center', exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'All Chats', exact: true }).waitFor({ timeout: 15_000 })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Command Center', exact: true }).waitFor({ timeout: 15_000 })
    assert.deepEqual(pageErrors, [], `Browser renderer errors: ${pageErrors.join(' | ')}`)
    console.log('[browser-e2e] PASS pairing, browser workspace mount, and reload session continuity')
  } finally {
    await browser.close().catch(() => {})
    await server.stop().catch(() => {})
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error('[browser-e2e] FAIL', error)
  process.exitCode = 1
})
