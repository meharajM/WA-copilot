import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const dataDir = '/tmp/aica-chat-persistence-test'
vi.mock('electron', () => ({ app: { getPath: () => dataDir }, ipcMain: { handle: vi.fn() } }))

describe('chat persistence', () => {
  it('merges message IDs and ignores stale renderer snapshots', async () => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(dataDir, { recursive: true })
    vi.resetModules()
    const { ChatPersistenceService } = await import('../../src/main/services/ChatPersistenceService')
    const service = ChatPersistenceService.getInstance()
    expect(service.saveSession({ id: 'session-1', title: 'Support', createdAt: 1, updatedAt: 2, messages: [{ id: 'm-1', role: 'user', content: 'Hello', timestamp: 1 }] })).toBe(true)
    expect(service.saveSession({ id: 'session-1', title: 'Stale', createdAt: 1, updatedAt: 1, messages: [{ id: 'm-stale', role: 'user', content: 'Should not replace', timestamp: 1 }] })).toBe(false)
    expect(service.saveSession({ id: 'session-1', title: 'Support', createdAt: 1, updatedAt: 3, messages: [{ id: 'm-2', role: 'assistant', content: 'Hi', timestamp: 2 }] })).toBe(true)
    expect(service.getAllSessions()[0].messages.map(message => message.id)).toEqual(['m-1', 'm-2'])
  })
})
