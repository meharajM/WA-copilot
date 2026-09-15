import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const requestedTarget = process.env.TAURI_ENV_TARGET_TRIPLE
if (requestedTarget && requestedTarget !== hostTriple) {
  throw new Error(
    `Cross-target sidecar preparation is unsupported: target ${requestedTarget} does not match host ${hostTriple}`,
  )
}

const targetTriple = requestedTarget || hostTriple
const executableExtension = targetTriple.includes('windows') ? '.exe' : ''
const sidecarDirectory = join(tauriRoot, 'binaries')
const sidecarPath = join(sidecarDirectory, `agentd-runtime-${targetTriple}${executableExtension}`)

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:agentd'], {
  cwd: projectRoot,
  shell: process.platform === 'win32',
})

await mkdir(sidecarDirectory, { recursive: true })
await cp(process.execPath, sidecarPath)
if (process.platform !== 'win32') await chmod(sidecarPath, 0o755)

await mkdir(join(tauriRoot, 'sidecar'), { recursive: true })
await cp(join(projectRoot, 'out', 'agentd'), join(tauriRoot, 'sidecar'), {
  recursive: true,
  force: true,
})

console.log(`Prepared Tauri sidecar for ${targetTriple}`)
