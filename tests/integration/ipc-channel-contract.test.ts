import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await getAllFiles(fullPath)))
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      results.push(fullPath)
    }
  }

  return results
}

function extractChannels(source: string, pattern: RegExp): Set<string> {
  const set = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    const channel = match[2] ?? match[1]
    if (channel) set.add(channel)
  }
  return set
}

describe('IPC channel contracts', () => {
  it('every preload invoke channel has a matching main handler', async () => {
    const preloadPath = path.resolve(process.cwd(), 'src/preload/index.ts')
    const preloadSource = await fs.readFile(preloadPath, 'utf8')
    const invokeChannels = extractChannels(
      preloadSource,
      /ipcRenderer\.invoke\(\s*(['"])([^'"]+)\1/g
    )

    const mainFiles = await getAllFiles(path.resolve(process.cwd(), 'src/main'))
    const mainSources = await Promise.all(
      mainFiles.map((file) => fs.readFile(file, 'utf8'))
    )
    const mainHandlers = new Set<string>()
    for (const source of mainSources) {
      for (const channel of extractChannels(
        source,
        /ipcMain\.handle\(\s*(['"])([^'"]+)\1/g
      )) {
        mainHandlers.add(channel)
      }
    }

    const missing = [...invokeChannels].filter((channel) => !mainHandlers.has(channel))
    expect(
      missing,
      `Missing ipcMain.handle() for channels: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('high-risk critical channels remain exposed in preload', async () => {
    const preloadPath = path.resolve(process.cwd(), 'src/preload/index.ts')
    const preloadSource = await fs.readFile(preloadPath, 'utf8')
    const invokeChannels = extractChannels(
      preloadSource,
      /ipcRenderer\.invoke\(\s*(['"])([^'"]+)\1/g
    )

    const required = [
      'llm:chat',
      'memory:call-tool',
      'whatsapp:send-message',
      'whatsapp:get-state',
      'intelligence:get-knowledge',
      'intelligence:log-accuracy',
      'secure:get',
      'store:get',
    ]

    const missingRequired = required.filter((channel) => !invokeChannels.has(channel))
    expect(
      missingRequired,
      `Preload lost critical channels: ${missingRequired.join(', ')}`
    ).toEqual([])
  })
})
