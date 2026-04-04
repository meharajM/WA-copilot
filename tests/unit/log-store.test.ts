import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadFreshLogStore() {
  vi.resetModules()

  const add = vi.fn().mockResolvedValue(undefined)
  const getPath = vi.fn().mockResolvedValue('/tmp/aica.log')
  const openFolder = vi.fn().mockResolvedValue(undefined)

  ;(globalThis as { window: Record<string, unknown> }).window = {
    ...(globalThis as { window: Record<string, unknown> }).window,
    electron: {
      logs: { add, getPath, openFolder },
    },
  }

  const mod = await import('../../src/renderer/src/stores/logStore')
  return { store: mod.useLogStore, add, getPath, openFolder }
}

describe('log store contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sanitizes sensitive fields before writing logs', async () => {
    const { store, add } = await loadFreshLogStore()

    await store.getState().addLog({
      sessionId: 's-1',
      eventType: 'DEBUG',
      component: 'RegressionTest',
      details: {
        input: {
          apiKey: 'secret',
          nested: {
            authorization: 'Bearer abc',
            password: 'pwd',
            safe: 'ok',
          },
        },
      },
    })

    expect(add).toHaveBeenCalledTimes(1)
    const payload = add.mock.calls[0][0] as {
      timestamp: string
      details: {
        input: {
          apiKey: string
          nested: { authorization: string; password: string; safe: string }
        }
      }
    }

    expect(typeof payload.timestamp).toBe('string')
    expect(payload.details.input.apiKey).toBe('***REDACTED***')
    expect(payload.details.input.nested.authorization).toBe('***REDACTED***')
    expect(payload.details.input.nested.password).toBe('***REDACTED***')
    expect(payload.details.input.nested.safe).toBe('ok')
  })

  it('proxies getLogPath/openLogFolder to electron logs API', async () => {
    const { store, getPath, openFolder } = await loadFreshLogStore()

    await expect(store.getState().getLogPath()).resolves.toBe('/tmp/aica.log')
    await store.getState().openLogFolder()

    expect(getPath).toHaveBeenCalledTimes(1)
    expect(openFolder).toHaveBeenCalledTimes(1)
  })
})

