const fs = require('node:fs')

const [operation, key] = process.argv.slice(2)
const filename = process.env.AICA_TEST_KEYRING_FILE
const records = filename && fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {}

function save() {
  fs.writeFileSync(filename, JSON.stringify(records), { mode: 0o600 })
}

if (!filename || !key) process.exit(1)
if (operation === 'get') {
  if (!(key in records)) process.exit(2)
  process.stdout.write(records[key])
} else if (operation === 'exists') {
  process.stdout.write(String(key in records))
} else if (operation === 'set') {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { value += chunk })
  process.stdin.on('end', () => {
    records[key] = value
    save()
  })
} else if (operation === 'delete') {
  delete records[key]
  save()
} else {
  process.exit(1)
}
