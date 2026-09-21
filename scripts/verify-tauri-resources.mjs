import { lstat, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join, relative, resolve } from 'node:path'

const WINDOWS_TARGET = /-windows-(?:msvc|gnu|gnullvm)(?:-|$)/
const PLATFORM_TARGETS = new Map([
  ['win32', WINDOWS_TARGET],
  ['darwin', /-apple-darwin$/],
  ['linux', /-linux(?:-|$)/],
])

const isFile = async (path) => {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

const isDirectory = async (path) => {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

async function findAsset(root, extension) {
  if (!(await isDirectory(root))) return null
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const match = await findAsset(path, extension)
      if (match) return match
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      return path
    }
  }
  return null
}

export async function verifyTauriResources({
  sidecarRoot,
  uiRoot,
  platform = process.platform,
  targetTriple,
} = {}) {
  const sidecar = resolve(sidecarRoot || 'src-tauri/sidecar')
  const ui = resolve(uiRoot || 'dist')
  const target = targetTriple || process.env.TAURI_ENV_TARGET_TRIPLE || ''
  const targetPattern = PLATFORM_TARGETS.get(platform)
  const errors = []

  if (!targetPattern) errors.push(`unsupported target platform: ${platform}`)
  if (!target) errors.push('target triple is required (pass --target-triple)')
  else if (targetPattern && !targetPattern.test(target)) errors.push(`target ${target} does not match platform ${platform}`)

  const extension = platform === 'win32' ? '.exe' : ''
  const runtime = join(sidecar, `agentd-runtime${extension}`)
  const helper = join(sidecar, `aica-keyring-helper${extension}`)
  const migrationReader = join(sidecar, `aica-migration-reader${extension}`)
  const betterSqliteRoot = join(sidecar, 'agentd-http', 'node_modules', 'better-sqlite3')
  const agentdNodeModules = join(sidecar, 'agentd-http', 'node_modules')
  const oppositeExtension = extension ? '' : '.exe'
  const requiredFiles = [
    runtime,
    helper,
    migrationReader,
    join(sidecar, 'agentd-http', 'index.cjs'),
    join(sidecar, 'agentd-http', 'server.cjs'),
    join(sidecar, 'agentd-http', 'continuity-migration.cjs'),
    join(sidecar, 'agentd-http', 'email-mime.cjs'),
    join(sidecar, 'agentd-http', 'email-attachment-safety.cjs'),
    join(sidecar, 'agentd-http', 'email-transport.cjs'),
    join(sidecar, 'agentd-http', 'email-inbound-worker.cjs'),
    join(sidecar, 'agentd-http', 'mcp-worker.cjs'),
    join(sidecar, 'agentd-http', 'speech-model.cjs'),
    join(sidecar, 'agentd-http', 'whatsapp-extension-bridge.cjs'),
    join(sidecar, 'agentd-http', 'keyring-credential-store.cjs'),
    join(betterSqliteRoot, 'package.json'),
    join(sidecar, 'agentd-http', 'node_modules', 'bindings', 'package.json'),
    join(sidecar, 'agentd-http', 'node_modules', 'file-uri-to-path', 'package.json'),
    join(agentdNodeModules, '@whiskeysockets', 'baileys', 'package.json'),
    join(agentdNodeModules, 'libsignal', 'package.json'),
    join(agentdNodeModules, '@modelcontextprotocol', 'sdk', 'package.json'),
    join(ui, 'tauri.html'),
  ]
  for (const path of requiredFiles) {
    if (!(await isFile(path))) errors.push(`missing staged resource: ${relative(process.cwd(), path)}`)
  }
  for (const path of [join(sidecar, `agentd-runtime${oppositeExtension}`), join(sidecar, `aica-keyring-helper${oppositeExtension}`), join(sidecar, `aica-migration-reader${oppositeExtension}`)]) {
    if (await isFile(path)) errors.push(`unexpected platform resource: ${relative(process.cwd(), path)}`)
  }
  if (!(await findAsset(ui, '.js'))) errors.push(`missing staged browser JavaScript asset under: ${relative(process.cwd(), ui)}`)
  if (!(await findAsset(ui, '.css'))) errors.push(`missing staged browser CSS asset under: ${relative(process.cwd(), ui)}`)
  if (!(await findAsset(betterSqliteRoot, '.node'))) {
    errors.push(`missing compiled better-sqlite3 native binding (.node) under: ${relative(process.cwd(), betterSqliteRoot)}`)
  }

  if (errors.length) throw new Error(`Tauri resource gate failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
  return { sidecarRoot: sidecar, uiRoot: ui, targetTriple: target, platform }
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
    const name = key.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${name}`)
    values[name] = value
    index += 1
  }
  return values
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2))
    await verifyTauriResources({
      sidecarRoot: args['sidecar-root'],
      uiRoot: args['ui-root'],
      platform: args.platform,
      targetTriple: args['target-triple'],
    })
    console.log('Tauri resource gate passed')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
