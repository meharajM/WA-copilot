import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadFreshExperimentStore() {
  vi.resetModules()
  localStorage.clear()
  const mod = await import('../../src/renderer/src/stores/experimentStore')
  const store = mod.useExperimentStore
  store.setState({
    assignments: {},
    overrides: {},
    registry: [],
  })
  return store
}

describe('experiment store contracts', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null for unknown or disabled experiments', async () => {
    const store = await loadFreshExperimentStore()
    store.getState().registerExperiments([
      { key: 'disabled_exp', variants: ['control', 'variant'], enabled: false },
    ])

    expect(store.getState().getVariant('missing')).toBeNull()
    expect(store.getState().getVariant('disabled_exp')).toBeNull()
  })

  it('auto-assigns variants and persists assignments', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const store = await loadFreshExperimentStore()

    store.getState().registerExperiments([
      { key: 'copy_button_placement', variants: ['control', 'top_right'], enabled: true },
    ])

    const variant = store.getState().getVariant('copy_button_placement')
    expect(variant).toBe('top_right')

    const assignments = store.getState().assignments
    expect(assignments.copy_button_placement?.variant).toBe('top_right')

    const persistedRaw = localStorage.getItem('aica-experiments')
    expect(persistedRaw).toBeTruthy()
    const persisted = JSON.parse(persistedRaw || '{}') as Record<string, { variant: string }>
    expect(persisted.copy_button_placement?.variant).toBe('top_right')

    randomSpy.mockRestore()
  })

  it('overrides take precedence, and clearing override restores assigned variant', async () => {
    const store = await loadFreshExperimentStore()
    store.getState().registerExperiments([
      { key: 'cta_copy', variants: ['control', 'alt'], enabled: true },
    ])
    store.getState().assignVariant('cta_copy', 'control')

    store.getState().setOverride('cta_copy', 'alt')
    expect(store.getState().getVariant('cta_copy')).toBe('alt')

    store.getState().clearOverride('cta_copy')
    expect(store.getState().getVariant('cta_copy')).toBe('control')
  })
})

