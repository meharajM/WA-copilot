import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../../vite.tauri.config'

describe('Tauri Vite output', () => {
  it('places the HTML entry at the configured frontend root', () => {
    const root = config.root as string
    const outDir = config.build?.outDir as string
    const input = (config.build?.rollupOptions?.input as Record<string, string>).index

    const htmlOutput = resolve(outDir, relative(root, input))
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

    expect(htmlOutput).toBe(resolve(projectRoot, 'dist/tauri.html'))
    expect(config.publicDir).toBe(false)
    expect(config.build?.emptyOutDir).toBe(true)
  })
})
