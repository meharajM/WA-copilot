const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')

test('WhatsApp Web extension outbound contract is syntax-valid and fail-closed by design', () => {
  for (const file of ['background.js', 'content.js', 'options.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, 'browser-extension', file)], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file} must parse: ${result.stderr}`)
  }
  const background = fs.readFileSync(path.join(root, 'browser-extension', 'background.js'), 'utf8')
  const content = fs.readFileSync(path.join(root, 'browser-extension', 'content.js'), 'utf8')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'browser-extension', 'manifest.json'), 'utf8'))
  assert.match(background, /\/outbound\?chatId=/)
  assert.match(background, /\/outbound\/result/)
  assert.doesNotMatch(background, /settings\.port/)
  assert.match(content, /activeChatMatches/)
  assert.match(content, /message_composer_unavailable/)
  assert.match(content, /media_input_unavailable/)
  assert.match(content, /input\[type="file"\]/)
  assert.deepEqual(manifest.host_permissions, ['https://web.whatsapp.com/*', 'http://127.0.0.1:8790/*'])
})
