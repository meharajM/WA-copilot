import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNodeHostMatchesRustTarget } from './tauri-target-validation.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriRoot = join(projectRoot, 'src-tauri')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
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
  throw new Error(`Cross-target migration-reader preparation is unsupported: target ${requestedTarget} does not match host ${hostTriple}`)
}

const targetTriple = requestedTarget || hostTriple
const executableExtension = targetTriple.includes('windows') ? '.exe' : ''
const resourcesDirectory = join(tauriRoot, 'sidecar')
const readerPath = join(resourcesDirectory, `aica-migration-reader${executableExtension}`)
const staleReaderPath = join(resourcesDirectory, `aica-migration-reader${executableExtension ? '' : '.exe'}`)

await mkdir(resourcesDirectory, { recursive: true })
run('cargo', ['build', '--release', '--locked', '--bin', 'aica-migration-reader', '--target', targetTriple], { cwd: tauriRoot })
await rm(staleReaderPath, { force: true })
await cp(join(tauriRoot, 'target', targetTriple, 'release', `aica-migration-reader${executableExtension}`), readerPath)
if (process.platform !== 'win32') await chmod(readerPath, 0o755)

console.log(`Prepared agentd migration reader for ${targetTriple}`)
