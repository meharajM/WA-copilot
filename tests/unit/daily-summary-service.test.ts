import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SerializedSession } from '../../src/main/services/ChatPersistenceService'

const { ipcHandle, shellOpenPath } = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  shellOpenPath: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
  },
  ipcMain: {
    handle: ipcHandle,
  },
  shell: {
    openPath: shellOpenPath,
  },
}))

import { DailySummaryService } from '../../src/main/services/DailySummaryService'

function makeSession(partial: Partial<SerializedSession>): SerializedSession {
  const now = Date.now()
  return {
    id: partial.id ?? 'session-1',
    title: partial.title ?? 'Session',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    channel: partial.channel,
    contact_id: partial.contact_id,
    status: partial.status ?? 'active',
    workspacePath: partial.workspacePath,
    topic: partial.topic,
    messages: partial.messages ?? [],
  }
}

describe('DailySummaryService', () => {
  let reportDir: string

  beforeEach(async () => {
    reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-summary-service-'))
    ipcHandle.mockReset()
    shellOpenPath.mockReset()
  })

  afterEach(async () => {
    await fs.rm(reportDir, { recursive: true, force: true })
  })

  it('writes daily JSON and markdown reports and logs generation', async () => {
    const logSpy = vi.fn()
    const inWindow = new Date('2026-04-04T10:00:00').getTime()

    const service = new DailySummaryService({
      reportDir,
      getSessions: () => [
        makeSession({
          id: 'wa-1',
          status: 'resolved',
          contact_id: '14155550000@s.whatsapp.net',
          topic: 'Order Status',
          updatedAt: inWindow,
          messages: [
            { id: 'm1', role: 'user', content: 'hello', timestamp: inWindow },
            { id: 'm2', role: 'assistant', content: 'hi', timestamp: inWindow + 5_000 },
          ],
        }),
      ],
      getIntelligenceStats: () => ({
        totalQueries: 7,
        resolvedQueries: 6,
        autonomyRate: 85.7,
        trainingCount: 1,
        learningCount: 2,
      }),
      logIntelligenceEvent: logSpy,
    })

    const result = service.generateDaily(new Date('2026-04-04T12:00:00'))
    expect(result.success).toBe(true)
    expect(result.jsonPath).toContain('2026-04-04.json')
    expect(result.markdownPath).toContain('2026-04-04.md')

    const markdown = await fs.readFile(result.markdownPath!, 'utf8')
    expect(markdown).toContain('# Daily Report - 2026-04-04')
    expect(markdown).toContain('## Metrics')

    expect(logSpy).toHaveBeenCalledWith(
      'learning',
      'daily_summary_generated',
      expect.stringContaining('2026-04-04')
    )
  })

  it('lists reports newest-first and returns latest report payload', () => {
    const service = new DailySummaryService({
      reportDir,
      getSessions: () => [makeSession({})],
      getIntelligenceStats: () => ({
        totalQueries: 0,
        resolvedQueries: 0,
        autonomyRate: 100,
        trainingCount: 0,
        learningCount: 0,
      }),
    })

    service.generateDaily(new Date('2026-04-03T12:00:00'))
    service.generateDaily(new Date('2026-04-04T12:00:00'))

    const listed = service.listDaily(5)
    expect(listed.success).toBe(true)
    expect(listed.reports).toEqual(['2026-04-04.json', '2026-04-03.json'])

    const latest = service.getLatest()
    expect(latest.success).toBe(true)
    expect((latest.report as { date: string }).date).toBe('2026-04-04')
  })

  it('guards invalid input date and invalid report key', () => {
    const service = new DailySummaryService({
      reportDir,
      getSessions: () => [],
      getIntelligenceStats: () => ({
        totalQueries: 0,
        resolvedQueries: 0,
        autonomyRate: 100,
        trainingCount: 0,
        learningCount: 0,
      }),
    })

    const invalidDate = service.generateDaily(new Date('invalid'))
    expect(invalidDate.success).toBe(false)
    expect(invalidDate.error).toBe('Invalid reference date')

    const invalidKey = service.getByDate('!!!')
    expect(invalidKey.success).toBe(false)
    expect(invalidKey.error).toBe('Invalid date key')
  })

  it('propagates shell open errors when opening reports folder', async () => {
    shellOpenPath.mockResolvedValueOnce('Could not open folder')

    const service = new DailySummaryService({
      reportDir,
      getSessions: () => [],
      getIntelligenceStats: () => ({
        totalQueries: 0,
        resolvedQueries: 0,
        autonomyRate: 100,
        trainingCount: 0,
        learningCount: 0,
      }),
    })

    const result = await service.openReportsFolder()
    expect(result).toEqual({ success: false, error: 'Could not open folder' })
    expect(shellOpenPath).toHaveBeenCalledWith(reportDir)
  })

  it('registers all report IPC channels', () => {
    const service = new DailySummaryService({
      reportDir,
      getSessions: () => [],
      getIntelligenceStats: () => ({
        totalQueries: 0,
        resolvedQueries: 0,
        autonomyRate: 100,
        trainingCount: 0,
        learningCount: 0,
      }),
    })

    service.registerIpc()
    const channels = ipcHandle.mock.calls.map((call) => call[0])

    expect(channels).toEqual([
      'report:generate-daily',
      'report:list-daily',
      'report:get-by-date',
      'report:get-latest',
      'report:open-folder',
    ])
  })
})
