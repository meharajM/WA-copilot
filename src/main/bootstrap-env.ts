import * as dotenv from 'dotenv'
import * as path from 'node:path'

// Load configuration before eager main-process singletons are constructed.
const files = [path.join(process.cwd(), '.env')]
if (typeof process.resourcesPath === 'string') files.push(path.join(process.resourcesPath, '.env'))
for (const file of files) {
  dotenv.config({ path: file, override: false })
}
