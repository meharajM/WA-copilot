import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { AntigravityAuthService } from '../../src/main/services/AntigravityAuthService'

const makeService = (refreshToken: string | null = null) => {
  const values = new Map<string, string>()
  if (refreshToken) values.set('antigravity_refresh_token', refreshToken)
  const deletes: string[] = []
  const service = new AntigravityAuthService({
    secureGet: async (key) => ({ value: values.get(key) || null }),
    secureSet: async (key, value) => { values.set(key, value) },
    secureDelete: async (key) => { deletes.push(key); values.delete(key) },
  })
  return { service, deletes }
}

describe('Electron Antigravity auth boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('restores only safe status fields and never exposes stored tokens', async () => {
    const { service } = makeService('refresh-secret')
    await service.initialize()

    expect(service.getStatus()).toEqual({
      signedIn: true,
      email: null,
      projectId: 'rising-fact-p41fc',
      accessToken: null,
      accessTokenExpiry: null,
      refreshToken: null,
    })
    await expect(service.callGateway('https://example.com/v1internal:generateContent', {}, '{}')).rejects.toThrow('not allowlisted')
  })

  it('fails closed when OAuth client configuration is absent', async () => {
    const { service } = makeService()
    await expect(service.signIn()).rejects.toThrow('Antigravity OAuth is not configured')
  })

  it('clears persisted session material on sign out', async () => {
    const { service, deletes } = makeService('refresh-secret')
    await service.initialize()
    await service.signOut()
    expect(deletes.sort()).toEqual([
      'antigravity_email',
      'antigravity_project_id',
      'antigravity_refresh_token',
    ])
    expect(service.getStatus().signedIn).toBe(false)
  })
})
