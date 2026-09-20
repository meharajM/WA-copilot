import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function filesUnder(root, extension) {
  const result = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(path, extension))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) result.push(path)
  }
  return result
}

async function artifact(path) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`empty Tauri artifact: ${path}`)
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  return { path, size: metadata.size, sha256: hash }
}

export async function verifyTauriWindowsBundle({ bundleRoot = 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle' } = {}) {
  const root = resolve(bundleRoot)
  const nsis = await filesUnder(join(root, 'nsis'), '.exe')
  const msi = await filesUnder(join(root, 'msi'), '.msi')
  const errors = []
  if (!nsis.length) errors.push(`missing NSIS installer under: ${relative(process.cwd(), join(root, 'nsis'))}`)
  if (!msi.length) errors.push(`missing MSI installer under: ${relative(process.cwd(), join(root, 'msi'))}`)
  if (errors.length) throw new Error(`Tauri Windows bundle gate failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
  const artifacts = await Promise.all([...nsis, ...msi].map(artifact))
  return { bundleRoot: root, artifacts }
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key !== '--bundle-root') throw new Error(`unexpected argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('missing value for --bundle-root')
    values.bundleRoot = value
  }
  return values
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await verifyTauriWindowsBundle(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify({ ...result, artifacts: result.artifacts.map((item) => ({ ...item, path: relative(process.cwd(), item.path) })) }, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
