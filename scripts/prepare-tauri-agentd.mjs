import { chmod, cp, mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNodeHostMatchesRustTarget } from './tauri-target-validation.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriRoot = join(projectRoot, 'src-tauri')
const sidecarRoot = join(tauriRoot, 'sidecar')
const stageRoot = join(sidecarRoot, 'agentd-http')
const projectRequire = createRequire(join(projectRoot, 'package.json'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

function rustHostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`rustc -vV failed with status ${result.status}`)
  const host = result.stdout.match(/^host: (.+)$/m)?.[1]
  if (!host) throw new Error('rustc -vV did not report a host target triple')
  return host
}

const hostTriple = rustHostTriple()
assertNodeHostMatchesRustTarget(process.platform, process.arch, hostTriple)
const requestedTarget = process.env.TAURI_ENV_TARGET_TRIPLE
if (requestedTarget && requestedTarget !== hostTriple) {
  throw new Error(`Cross-target agentd preparation is unsupported: target ${requestedTarget} does not match host ${hostTriple}`)
}

await rm(stageRoot, { recursive: true, force: true })
await mkdir(join(stageRoot, 'node_modules'), { recursive: true })
await cp(join(projectRoot, 'agentd', 'server.cjs'), join(stageRoot, 'server.cjs'))
await cp(join(projectRoot, 'agentd', 'keyring-credential-store.cjs'), join(stageRoot, 'keyring-credential-store.cjs'))
await cp(join(projectRoot, 'agentd', 'gmail-oauth.cjs'), join(stageRoot, 'gmail-oauth.cjs'))
await cp(join(projectRoot, 'agentd', 'gmail-api.cjs'), join(stageRoot, 'gmail-api.cjs'))
await cp(join(projectRoot, 'agentd', 'whatsapp-baileys.cjs'), join(stageRoot, 'whatsapp-baileys.cjs'))
await cp(join(projectRoot, 'agentd', 'whatsapp-extension-bridge.cjs'), join(stageRoot, 'whatsapp-extension-bridge.cjs'))
await cp(join(projectRoot, 'agentd', 'continuity-migration.cjs'), join(stageRoot, 'continuity-migration.cjs'))
await cp(join(projectRoot, 'agentd', 'email-mime.cjs'), join(stageRoot, 'email-mime.cjs'))
await cp(join(projectRoot, 'agentd', 'email-attachment-safety.cjs'), join(stageRoot, 'email-attachment-safety.cjs'))
await cp(join(projectRoot, 'agentd', 'email-transport.cjs'), join(stageRoot, 'email-transport.cjs'))
await cp(join(projectRoot, 'agentd', 'email-inbound-worker.cjs'), join(stageRoot, 'email-inbound-worker.cjs'))
await cp(join(projectRoot, 'agentd', 'mcp-worker.cjs'), join(stageRoot, 'mcp-worker.cjs'))
await cp(join(projectRoot, 'agentd', 'speech-model.cjs'), join(stageRoot, 'speech-model.cjs'))
await cp(join(projectRoot, 'package.json'), join(stageRoot, 'package.json'))
await cp(join(projectRoot, 'scripts', 'tauri-agentd-runner.cjs'), join(stageRoot, 'index.cjs'))

// Stage only the dependency closure used by agentd. Baileys loads lazily on
// connect, but its packages must still exist in the packaged sidecar.
const dependencies = new Map()
const requiredDependencies = new Set(['better-sqlite3', 'bindings', 'file-uri-to-path', '@whiskeysockets/baileys', '@modelcontextprotocol/sdk'])
const queue = [...requiredDependencies]
while (queue.length) {
  const dependency = queue.shift()
  if (dependencies.has(dependency)) continue
  let resolved
  for (const candidate of [dependency, dependency === '@modelcontextprotocol/sdk' ? `${dependency}/client` : null].filter(Boolean)) {
    try {
      resolved = projectRequire.resolve(candidate)
      break
    } catch {}
  }
  if (!resolved) {
    if (requiredDependencies.has(dependency)) throw new Error(`Missing agentd dependency: ${dependency}`)
    continue
  }
  let packageRoot = dirname(resolved)
  while (packageRoot !== projectRoot && packageRoot !== dirname(packageRoot)) {
    try {
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      if (manifest.name) {
        dependencies.set(dependency, { packageRoot, manifest })
        for (const child of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) queue.push(child)
        break
      }
    } catch {}
    packageRoot = dirname(packageRoot)
  }
  if (!dependencies.has(dependency) && requiredDependencies.has(dependency)) throw new Error(`Missing agentd package manifest: ${dependency}`)
}
for (const [dependency, { packageRoot }] of dependencies) {
  const destination = join(stageRoot, 'node_modules', dependency)
  await mkdir(dirname(destination), { recursive: true })
  await cp(packageRoot, destination, { recursive: true })
}

const runtimePath = join(sidecarRoot, `agentd-runtime${process.platform === 'win32' ? '.exe' : ''}`)
const staleRuntimePath = join(sidecarRoot, `agentd-runtime${process.platform === 'win32' ? '' : '.exe'}`)
await rm(staleRuntimePath, { force: true })
await cp(process.execPath, runtimePath)
if (process.platform !== 'win32') await chmod(runtimePath, 0o755)

console.log(`Prepared packaged agentd runtime for ${hostTriple}`)
