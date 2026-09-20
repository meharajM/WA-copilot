import { BrowserWindow, ipcMain } from 'electron'
import {
  emailChannelService,
  type EmailPollingConfig,
  type OutboundEmailPayload
} from '../services/EmailChannelService'
import { autonomousSupervisor } from '../services/AutonomousSupervisor'

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
    if (message && typeof message === 'object' && 'channel' in message && (message as { channel?: string }).channel === 'email') autonomousSupervisor.onEmailMessage(message as Parameters<typeof autonomousSupervisor.onEmailMessage>[0])
    broadcast('email:message', message)
  })

  emailChannelService.on('deliveryStatus', (status) => {
    if (status && typeof status === 'object' && (status as { status?: string }).status === 'failed' && typeof (status as { providerMessageId?: unknown }).providerMessageId === 'string') autonomousSupervisor.recordEmailBounce(status as { providerMessageId: string; at: number; inReplyTo?: string })
    broadcast('email:delivery-status', status)
  })

  ipcMain.handle('email:get-state', async () => {
    console.log('[Email IPC] get-state')
    return emailChannelService.getConnectionState()
  })

  ipcMain.handle('email:configure', async (_event, config: EmailPollingConfig) => {
    console.log('[Email IPC] configure', {
      command: config.command,
      args: config.args,
      accountName: config.accountName,
      pollingIntervalSeconds: config.pollingIntervalSeconds
    })
    emailChannelService.configure(config)
    return { success: true }
  })

  ipcMain.handle('email:start', async () => {
    console.log('[Email IPC] start')
    try {
      await emailChannelService.start()
      console.log('[Email IPC] start success')
      return { success: true }
    } catch (error) {
      console.error('[Email IPC] start failed', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('email:stop', async () => {
    console.log('[Email IPC] stop')
    try {
      await emailChannelService.stop()
      return { success: true }
    } catch (error) {
      console.error('[Email IPC] stop failed', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('email:send', async (_event, payload: OutboundEmailPayload) => {
    console.log('[Email IPC] send', { to: payload.to, subject: payload.subject, accountName: payload.accountName })
    return emailChannelService.send(payload)
  })
}
