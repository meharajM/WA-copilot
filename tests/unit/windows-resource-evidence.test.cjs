const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const script = fs.readFileSync(path.join(root, 'scripts/windows-resource-evidence.ps1'), 'utf8')

test('Windows resource evidence harness records both migration dimensions without fabricating measurements', () => {
  assert.match(script, /ValidateSet\('open', 'closed'\)/)
  assert.match(script, /ValidateSet\('loaded', 'unloaded'\)/)
  assert.match(script, /ui = \$UiState/)
  assert.match(script, /model = \$ModelState/)
  assert.match(script, /schemaVersion = 'windows-resource-evidence\.v1'/)
  assert.match(script, /peakResidentSetMb/)
  assert.match(script, /averageCpuPercent/)
  assert.doesNotMatch(script, /MaxResidentSetMb|MaxAverageCpuPercent/)
})

test('Windows resource evidence harness bounds process discovery and sampling output', () => {
  assert.match(script, /seen\.Count -le 128/)
  assert.match(script, /ValidateRange\(2, 300\)/)
  assert.match(script, /ValidateRange\(2, 600\)/)
  assert.match(script, /requestedSeconds = \$SampleSeconds/)
  assert.match(script, /processes = \$processMetadata/)
  assert.match(script, /samples = \$samples/)
  assert.match(script, /Get-CimInstance Win32_Process/)
})
