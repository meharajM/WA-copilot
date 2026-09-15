import { resolve, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../vite.tauri.config'

describe('Tauri Vite output', () => {
  it('places the HTML entry at the configured frontend root', () => {
    const root = config.root as string
    const outDir = config.build?.outDir as string
    const input = (config.build?.rollupOptions?.input as Record<string, string>).index

    expect(resolve(outDir, relative(root, input))).toBe(resolve(outDir, 'tauri.html'))
  })
})
