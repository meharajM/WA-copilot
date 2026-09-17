import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('main environment bootstrap', () => {
  it('is imported before the main-process singleton imports', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
    const bootstrap = source.indexOf("import './bootstrap-env'")
    expect(bootstrap).toBeGreaterThanOrEqual(0)
    expect(bootstrap).toBeLessThan(source.indexOf("from './services/AutonomousSupervisor'"))
  })

  it('guards Electron-only resource paths for plain Node tooling', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/bootstrap-env.ts'), 'utf8')
    expect(source).toContain("typeof process.resourcesPath === 'string'")
  })
})
