#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { PAIRING_TTL_MS, resolveDataDir } = require('../agentd/server.cjs')

const dataDir = resolveDataDir()
const codePath = path.join(dataDir, 'agentd.pairing-code')
const descriptorPath = path.join(dataDir, 'agentd.runtime.json')

try {
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
  const file = fs.lstatSync(codePath)
  if (!file.isFile()) throw new Error('Pairing code is unavailable or expired')
  const origin = new URL(descriptor.origin)
  if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) throw new Error('Pairing file permissions are too broad')
  if (!Number.isSafeInteger(descriptor.pid) || origin.hostname !== '127.0.0.1' || Date.now() - file.mtimeMs > PAIRING_TTL_MS) {
    throw new Error('Pairing code is unavailable or expired')
  }
  try { process.kill(descriptor.pid, 0) }
  catch (error) { if (error.code !== 'EPERM') throw new Error('agentd is not running') }
  const code = fs.readFileSync(codePath, 'utf8').trim()
  if (!/^\d{6}$/.test(code)) throw new Error('Pairing code is unavailable or expired')
  process.stdout.write(`${code}\n`)
} catch (error) {
  process.stderr.write(`[agentd] ${error.message}\n`)
  process.exitCode = 1
}
