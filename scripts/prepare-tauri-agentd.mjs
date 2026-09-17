import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNodeHostMatchesRustTarget } from './tauri-target-validation.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriRoot = join(projectRoot, 'src-tauri')
const sidecarRoot = join(tauriRoot, 'sidecar')
const stageRoot = join(sidecarRoot, 'agentd-http')

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
await cp(join(projectRoot, 'scripts', 'tauri-agentd-runner.cjs'), join(stageRoot, 'index.cjs'))
for (const dependency of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  await cp(join(projectRoot, 'node_modules', dependency), join(stageRoot, 'node_modules', dependency), { recursive: true })
}

const runtimePath = join(sidecarRoot, `agentd-runtime${process.platform === 'win32' ? '.exe' : ''}`)
await cp(process.execPath, runtimePath)
if (process.platform !== 'win32') await chmod(runtimePath, 0o755)

console.log(`Prepared packaged agentd runtime for ${hostTriple}`)
