import { BrowserWindow, ipcMain } from 'electron'
import {
  emailChannelService,
  type EmailPollingConfig,
  type OutboundEmailPayload
} from '../services/EmailChannelService'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

export function registerEmailHandlers(): void {
  emailChannelService.on('connectionChange', (state) => {
    broadcast('email:connection-change', state)
  })

  emailChannelService.on('message', (message) => {
    broadcast('email:message', message)
  })

  emailChannelService.on('deliveryStatus', (status) => {
    broadcast('email:delivery-status', status)
  })

  ipcMain.handle('email:get-state', async () => {
    return emailChannelService.getConnectionState()
  })

  ipcMain.handle('email:configure', async (_event, config: EmailPollingConfig) => {
    emailChannelService.configure(config)
    return { success: true }
  })

  ipcMain.handle('email:start', async () => {
    try {
      await emailChannelService.start()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('email:stop', async () => {
    try {
      await emailChannelService.stop()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('email:send', async (_event, payload: OutboundEmailPayload) => {
    return emailChannelService.send(payload)
  })
}

