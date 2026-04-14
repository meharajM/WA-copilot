import { ipcMain } from 'electron'
import { gmailOAuthService } from '../services/GmailOAuthService'

export function registerEmailOAuthHandlers(): void {
  ipcMain.handle('email-oauth:initialize', async () => {
    await gmailOAuthService.initialize()
    return gmailOAuthService.getStatus()
  })

  ipcMain.handle('email-oauth:sign-in-google', async () => {
    return gmailOAuthService.signIn()
  })

  ipcMain.handle('email-oauth:sign-out', async () => {
    await gmailOAuthService.signOut()
    return { success: true }
  })

  ipcMain.handle('email-oauth:get-status', async () => {
    await gmailOAuthService.initialize()
    return gmailOAuthService.getStatus()
  })

  ipcMain.handle('email-oauth:get-access-token', async () => {
    const token = await gmailOAuthService.getAccessToken()
    return { token }
  })
}
