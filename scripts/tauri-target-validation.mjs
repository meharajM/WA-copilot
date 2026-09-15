const architecturePatterns = new Map([
  ['x64', /^x86_64-/],
  ['arm64', /^aarch64-/],
  ['ia32', /^i[3-6]86-/],
  ['arm', /^arm(?:v\d+)?-/],
])

const platformPatterns = new Map([
  ['darwin', /-apple-darwin$/],
  ['linux', /-linux(?:-|$)/],
  ['win32', /-windows-(?:msvc|gnu|gnullvm)(?:-|$)/],
])

export function assertNodeHostMatchesRustTarget(platform, arch, targetTriple) {
  const architecturePattern = architecturePatterns.get(arch)
  const platformPattern = platformPatterns.get(platform)
  if (!architecturePattern || !platformPattern) {
    throw new Error(`Unsupported Node host: ${platform}/${arch}`)
  }

  if (!architecturePattern.test(targetTriple) || !platformPattern.test(targetTriple)) {
    throw new Error(`Node host ${platform}/${arch} does not match Rust target ${targetTriple}`)
  }
}
