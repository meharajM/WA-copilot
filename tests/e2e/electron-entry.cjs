const { app } = require('electron')
const { pathToFileURL } = require('node:url')

const entryPath = process.env.WA_COPILOT_E2E_MAIN
const userDataPath = process.env.WA_COPILOT_E2E_USER_DATA

if (!entryPath || !userDataPath) {
  throw new Error('The E2E Electron bootstrap requires main and userData paths.')
}

app.setPath('userData', userDataPath)
app.commandLine.appendSwitch('disable-background-networking')

import(pathToFileURL(entryPath).href).catch((error) => {
  console.error('[e2e] Failed to load the Electron main entry:', error)
  app.exit(1)
})
