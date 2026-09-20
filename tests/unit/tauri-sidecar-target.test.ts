import { describe, expect, it } from 'vitest'
import { assertNodeHostMatchesRustTarget } from '../../scripts/tauri-target-validation.mjs'

describe('Tauri sidecar target validation', () => {
  it('accepts a Rust triple matching the Node OS and architecture', () => {
    expect(() =>
      assertNodeHostMatchesRustTarget('darwin', 'arm64', 'aarch64-apple-darwin')
    ).not.toThrow()
    expect(() =>
      assertNodeHostMatchesRustTarget('win32', 'x64', 'x86_64-pc-windows-msvc')
    ).not.toThrow()
  })

  it('rejects an architecture mismatch', () => {
    expect(() =>
      assertNodeHostMatchesRustTarget('darwin', 'arm64', 'x86_64-apple-darwin')
    ).toThrow('does not match Rust target')
  })

  it('rejects an operating system mismatch', () => {
    expect(() =>
      assertNodeHostMatchesRustTarget('darwin', 'arm64', 'aarch64-unknown-linux-gnu')
    ).toThrow('does not match Rust target')
  })
})
