const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const script = path.resolve(__dirname, '../../scripts/verify-tauri-resources.mjs')

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aica-tauri-resources-'))
  const sidecar = path.join(root, 'sidecar')
  const ui = path.join(root, 'dist')
  const files = [
    'agentd-runtime.exe',
    'aica-keyring-helper.exe',
    'aica-migration-reader.exe',
    'agentd-http/index.cjs',
    'agentd-http/server.cjs',
    'agentd-http/keyring-credential-store.cjs',
    'agentd-http/node_modules/better-sqlite3/package.json',
    'agentd-http/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'agentd-http/node_modules/bindings/package.json',
    'agentd-http/node_modules/file-uri-to-path/package.json',
  ]
  for (const file of files) {
    const target = path.join(sidecar, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{}')
  }
  await fs.mkdir(path.join(ui, 'assets'), { recursive: true })
  await fs.writeFile(path.join(ui, 'tauri.html'), '<html></html>')
  await fs.writeFile(path.join(ui, 'assets', 'index.js'), '')
  await fs.writeFile(path.join(ui, 'assets', 'index.css'), '')
  return { root, sidecar, ui }
}

async function verify(options) {
  const module = await import(pathToFileURL(script).href)
  return module.verifyTauriResources(options)
}

test('resource verifier accepts a complete Windows staging fixture', async () => {
  const paths = await fixture()
  try {
    await assert.doesNotReject(verify({ sidecarRoot: paths.sidecar, uiRoot: paths.ui, platform: 'win32', targetTriple: 'x86_64-pc-windows-msvc' }))
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})

test('resource verifier reports missing staged files and assets', async () => {
  const paths = await fixture()
  try {
    await fs.rm(path.join(paths.sidecar, 'agentd-http', 'server.cjs'))
    await fs.rm(path.join(paths.ui, 'assets', 'index.css'))
    await assert.rejects(
      verify({ sidecarRoot: paths.sidecar, uiRoot: paths.ui, platform: 'win32', targetTriple: 'x86_64-pc-windows-msvc' }),
      /missing staged resource:.*server\.cjs.*missing staged browser CSS asset/s,
    )
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})

test('resource verifier rejects staging without a compiled better-sqlite3 binding', async () => {
  const paths = await fixture()
  try {
    await fs.rm(path.join(paths.sidecar, 'agentd-http', 'node_modules', 'better-sqlite3', 'build'), { recursive: true })
    await assert.rejects(
      verify({ sidecarRoot: paths.sidecar, uiRoot: paths.ui, platform: 'win32', targetTriple: 'x86_64-pc-windows-msvc' }),
      /missing compiled better-sqlite3 native binding.*\.node/,
    )
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})

test('resource verifier enforces Windows executable suffixes and target match', async () => {
  const paths = await fixture()
  try {
    await fs.rename(path.join(paths.sidecar, 'agentd-runtime.exe'), path.join(paths.sidecar, 'agentd-runtime'))
    await assert.rejects(verify({ sidecarRoot: paths.sidecar, uiRoot: paths.ui, platform: 'win32', targetTriple: 'x86_64-pc-windows-msvc' }), /agentd-runtime\.exe/)
    await assert.rejects(verify({ sidecarRoot: paths.sidecar, uiRoot: paths.ui, platform: 'win32', targetTriple: 'aarch64-apple-darwin' }), /does not match platform win32/)
  } finally {
    await fs.rm(paths.root, { recursive: true, force: true })
  }
})
