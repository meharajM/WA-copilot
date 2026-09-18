import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, rm } from 'node:fs/promises'
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
  throw new Error(
    `Cross-target keyring-helper preparation is unsupported: target ${requestedTarget} does not match host ${hostTriple}`,
  )
}

const targetTriple = requestedTarget || hostTriple
const executableExtension = targetTriple.includes('windows') ? '.exe' : ''
const resourcesDirectory = join(tauriRoot, 'sidecar')
const keyringHelperPath = join(resourcesDirectory, `aica-keyring-helper${executableExtension}`)
const staleKeyringHelperPath = join(resourcesDirectory, `aica-keyring-helper${executableExtension ? '' : '.exe'}`)

await mkdir(resourcesDirectory, { recursive: true })
run(
  'cargo',
  ['build', '--release', '--locked', '--bin', 'aica-keyring-helper', '--target', targetTriple],
  { cwd: tauriRoot },
)
await rm(staleKeyringHelperPath, { force: true })
await cp(
  join(tauriRoot, 'target', targetTriple, 'release', `aica-keyring-helper${executableExtension}`),
  keyringHelperPath,
)
if (process.platform !== 'win32') await chmod(keyringHelperPath, 0o755)

console.log(`Prepared agentd keyring helper for ${targetTriple}`)
