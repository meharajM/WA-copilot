#!/usr/bin/env node

/*
 * Electron embeds a different Node ABI than the host Node process. The
 * renderer smoke loads the Electron main process, which in turn loads
 * better-sqlite3, so the native binding must be rebuilt for Electron for the
 * duration of the smoke. Restore the host-Node binding afterwards so unit and
 * integration tests remain runnable in the same checkout.
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const electronVersion = require('electron/package.json').version

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

let exitCode = 0
try {
  run(npm, [
    'rebuild',
    'better-sqlite3',
    '--runtime=electron',
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
    '--build-from-source',
    '--no-audit',
    '--no-fund',
  ])
  run(process.execPath, [path.join(repoRoot, 'tests/e2e/electron-smoke.cjs')])
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  try {
    // Restore the binding used by Node/Vitest and the agentd unit fixtures.
    run(npm, ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'])
  } catch (error) {
    console.error(`[e2e] failed to restore host native modules: ${error instanceof Error ? error.message : String(error)}`)
    exitCode = 1
  }
}

process.exitCode = exitCode
