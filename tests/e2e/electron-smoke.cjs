const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const repoRoot = path.resolve(__dirname, '../..')
const mainEntry = path.join(repoRoot, 'out/main/index.js')
const bootstrapEntry = path.join(__dirname, 'electron-entry.cjs')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-copilot-e2e-'))
const userDataPath = path.join(tempRoot, 'user-data')
const packagedExecutable = process.env.WA_COPILOT_E2E_EXECUTABLE

let electronApp

async function visible(locator, description) {
  await locator.waitFor({ state: 'visible', timeout: 15_000 }).catch((error) => {
    error.message = `${description} should be visible\n${error.message}`
    throw error
  })
}

async function toggleState(page, label, expectedIcon) {
  const row = page.getByText(label, { exact: true }).locator('..').locator('..')
  await visible(row, `${label} setting`)
  const icon = row.locator(`button svg.lucide-${expectedIcon}`)
  await visible(icon, `${label} ${expectedIcon} icon`)
}

async function installSafetyGuards(app) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__WA_COPILOT_E2E_EXTERNAL_CALLS__ = []

    const guard = (channel, result) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args) => {
        globalThis.__WA_COPILOT_E2E_EXTERNAL_CALLS__.push({ channel, args })
        return result
      })
    }

    ipcMain.removeHandler('app:get-missing-dependencies')
    ipcMain.handle('app:get-missing-dependencies', () => [])

    ipcMain.removeHandler('secure:get')
    ipcMain.handle('secure:get', () => ({ success: true, value: null }))

    guard('email:configure', { success: false, error: 'Blocked by E2E safety guard' })
    guard('email:start', { success: false, error: 'Blocked by E2E safety guard' })
    guard('email:send', { success: false, error: 'Blocked by E2E safety guard' })
    guard('whatsapp:send-message', { success: false, error: 'Blocked by E2E safety guard' })
    guard('whatsapp:send-media-message', { success: false, error: 'Blocked by E2E safety guard' })
  })
}

async function run() {
  assert.equal(fs.existsSync(mainEntry), true, `Missing built Electron entry: ${mainEntry}`)
  fs.mkdirSync(userDataPath, { recursive: true })

  electronApp = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable ? [`--user-data-dir=${userDataPath}`] : [bootstrapEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...(!packagedExecutable ? {
        WA_COPILOT_E2E_MAIN: mainEntry,
        WA_COPILOT_E2E_USER_DATA: userDataPath,
      } : {}),
    },
    timeout: 30_000,
  })

  await installSafetyGuards(electronApp)

  const page = await electronApp.firstWindow({ timeout: 30_000 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  const actualUserDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(
    fs.realpathSync(actualUserDataPath),
    fs.realpathSync(userDataPath),
    'Electron userData must be isolated for E2E'
  )

  await page.getByText('Checking system dependencies...', { exact: true }).waitFor({ state: 'hidden', timeout: 15_000 })
  await visible(page.getByRole('button', { name: 'Command Center', exact: true }), 'Command Center navigation')
  await visible(page.getByRole('button', { name: 'All Chats', exact: true }), 'All Chats navigation')

  const header = page.getByRole('banner')
  await header.getByRole('button', { name: 'Conversations', exact: true }).click()
  await visible(page.getByTestId('chat-textarea'), 'chat view')
  await header.getByRole('button', { name: 'Dashboard', exact: true }).click()

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  const settingsCommand = page.locator('[cmdk-item]').filter({ hasText: 'Settings' })
  await visible(settingsCommand, 'Settings command')
  await settingsCommand.click()
  await visible(page.getByText('System Control', { exact: true }), 'settings shell')
  await visible(page.getByText('WhatsApp Business Configuration', { exact: true }), 'default settings section')

  await page.getByRole('button', { name: 'Email Channel', exact: true }).click()
  await visible(page.getByText('Email Channel Configuration', { exact: true }), 'Email Channel settings')
  await visible(page.getByText(/Keep Draft Mode on and Auto-Reply off until verification is complete/), 'email safety guidance')

  await toggleState(page, 'Draft Mode', 'toggle-right')
  await toggleState(page, 'Auto-Reply', 'toggle-left')
  await toggleState(page, 'Enable Email Channel', 'toggle-left')

  const testConnection = page.getByRole('button', { name: 'Test Connection', exact: true })
  assert.equal(await testConnection.isDisabled(), true, 'Test Connection must be disabled without credentials')

  await page.getByRole('button', { name: /Gmail Recommended:/ }).click()
  const appPassword = page.getByRole('button', { name: /App Password Recommended/ })
  await visible(appPassword, 'Gmail app-password option')
  assert.match(await appPassword.getAttribute('class'), /border-\[var\(--color-brand-teal\)\]/, 'Gmail must default to app-password auth')

  await page.getByRole('button', { name: 'Show server settings', exact: true }).click()
  const imapHost = page.getByText('IMAP Host', { exact: true }).locator('..').locator('input')
  const smtpHost = page.getByText('SMTP Host', { exact: true }).locator('..').locator('input')
  assert.equal(await imapHost.inputValue(), 'imap.gmail.com', 'Gmail IMAP preset should load')
  assert.equal(await smtpHost.inputValue(), 'smtp.gmail.com', 'Gmail SMTP preset should load')

  const externalCalls = await electronApp.evaluate(() => globalThis.__WA_COPILOT_E2E_EXTERNAL_CALLS__)
  assert.deepEqual(externalCalls, [], 'Smoke test must not configure, start, or send through external channels')
  assert.deepEqual(pageErrors, [], `Renderer page errors: ${pageErrors.join(' | ')}`)

  console.log('[e2e] PASS startup, navigation, settings, Email Channel UI, and safe defaults')
  console.log(`[e2e] isolated userData: ${actualUserDataPath}`)
}

run()
  .catch((error) => {
    console.error('[e2e] FAIL', error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (electronApp) {
      await electronApp.close().catch(() => {})
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
