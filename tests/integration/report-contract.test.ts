import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  const filePath = path.resolve(process.cwd(), relativePath)
  return fs.readFile(filePath, 'utf8')
}

function expectAll(source: string, tokens: string[], scope: string): void {
  for (const token of tokens) {
    expect(source, `${scope} is missing token: ${token}`).toContain(token)
  }
}

describe('reporting pipeline contracts', () => {
  it('preload exposes all report channels', async () => {
    const preloadSource = await readSource('src/preload/index.ts')

    expectAll(
      preloadSource,
      [
        'report:generate-daily',
        'report:list-daily',
        'report:get-by-date',
        'report:get-latest',
        'report:open-folder',
      ],
      'preload report channels'
    )
  })

  it('renderer electron wrapper keeps report bridge methods', async () => {
    const electronSource = await readSource('src/renderer/src/lib/electron.ts')

    expectAll(
      electronSource,
      [
        'reports:',
        'generateDaily: async',
        'listDaily: async',
        'getByDate: async',
        'getLatest: async',
        'openFolder: async',
      ],
      'renderer report bridge'
    )
  })

  it('renderer typings include report API surface', async () => {
    const envSource = await readSource('src/renderer/src/env.d.ts')

    expectAll(
      envSource,
      [
        'reports: {',
        'generateDaily:',
        'listDaily:',
        'getByDate:',
        'getLatest:',
        'openFolder:',
      ],
      'renderer report typings'
    )
  })

  it('main summary service registers all report handlers', async () => {
    const serviceSource = await readSource('src/main/services/DailySummaryService.ts')

    expectAll(
      serviceSource,
      [
        "ipcMain.handle('report:generate-daily'",
        "ipcMain.handle('report:list-daily'",
        "ipcMain.handle('report:get-by-date'",
        "ipcMain.handle('report:get-latest'",
        "ipcMain.handle('report:open-folder'",
      ],
      'daily summary service IPC registration'
    )
  })
})
