const suite = process.argv[2] || 'requested'

console.error(
  `[test:${suite}] No ${suite} E2E suite exists. ` +
  'This command intentionally fails instead of reporting unrelated tests as a pass.'
)
process.exitCode = 1
