import { describe, expect, it, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Mock Electron explicitly for the persona module
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn().mockReturnValue('/mock/userData')
    }
}))

// Mock node:fs to prevent actual file writes
vi.mock('node:fs', () => ({
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn()
}))

// Import after mocks
import { BusinessPersona } from '../../src/main/packages/persona/index'

describe('BusinessPersona Unit Tests', () => {
    
    beforeEach(() => {
        vi.clearAllMocks()
        // Reset singleton instance by replacing it dynamically
        // Since it's a private static, we can bypass TS for testing purposes
        // @ts-expect-error - reset singleton
        BusinessPersona.instance = undefined;
    })

    it('initializes with default profile if no file exists', () => {
        const persona = BusinessPersona.getInstance()
        const profile = persona.getProfile()
        
        expect(profile.name).toBe('Our Business')
        expect(profile.industry).toBe('Retail')
        expect(profile.tone).toBe('professional')
        expect(profile.coreKnowledge).toEqual([])
        expect(profile.customRules).toBeUndefined()
    })

    it('loads profile from disk if it exists', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
            name: 'DiskBot',
            industry: 'Disk Storage',
            tone: 'casual',
            customRules: 'Disk rules rule!'
        }))

        const persona = BusinessPersona.getInstance()
        const profile = persona.getProfile()

        expect(profile.name).toBe('DiskBot')
        expect(profile.industry).toBe('Disk Storage')
        expect(profile.tone).toBe('casual')
        expect(profile.customRules).toBe('Disk rules rule!')
    })

    it('updates profile and flushes to disk securely', async () => {
        const persona = BusinessPersona.getInstance()
        
        await persona.updateProfile({
            name: 'Updated Bot',
            tone: 'enthusiastic',
            customRules: 'Never say hello.'
        })

        const profile = persona.getProfile()
        
        expect(profile.name).toBe('Updated Bot')
        expect(profile.tone).toBe('enthusiastic')
        expect(profile.customRules).toBe('Never say hello.')
        
        // Assert it wrote to the file via fs
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
        
        // Check the arguments passed to fs.writeFileSync
        const writeArgs = vi.mocked(fs.writeFileSync).mock.calls[0]
        expect(writeArgs[0]).toBe(path.join('/mock/userData', 'business_profile.json'))
        expect(writeArgs[1]).toContain('"name": "Updated Bot"')
        expect(writeArgs[1]).toContain('"customRules": "Never say hello."')
    })
})
