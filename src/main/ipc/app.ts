import { app, shell, ipcMain, dialog } from 'electron'
import { isSafeExternalUrl } from '../utils/external-url'

export function registerAppHandlers(): void {
    // Shell operations
    ipcMain.handle('shell:open-external', async (_event, url: unknown) => {
        if (!isSafeExternalUrl(url)) throw new Error('Only http(s) external URLs are allowed')
        await shell.openExternal(url)
    })

    // App info
    ipcMain.handle('app:get-version', () => app.getVersion())
    ipcMain.handle('app:get-name', () => app.getName())

    // Folder selection
    ipcMain.handle('app:select-folder', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select Workspace Folder',
            buttonLabel: 'Select Workspace'
        })
        return result.canceled ? null : result.filePaths[0]
    })

    // File selection
    ipcMain.handle('app:select-file', async (_event, { title, buttonLabel, filters }: { title?: string, buttonLabel?: string, filters?: { name: string, extensions: string[] }[] }) => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: title || 'Select File',
            buttonLabel: buttonLabel || 'Select',
            filters: filters || [
                { name: 'Documents', extensions: ['pdf', 'txt', 'csv', 'docx', 'xlsx', 'pptx'] },
                { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        })
        return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('app:select-files', async (_event, { title, buttonLabel, filters }: { title?: string, buttonLabel?: string, filters?: { name: string, extensions: string[] }[] } = {}) => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            title: title || 'Select Files',
            buttonLabel: buttonLabel || 'Select',
            filters: filters || [
                { name: 'Documents', extensions: ['pdf', 'txt', 'csv', 'docx', 'xlsx', 'pptx'] },
                { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        })
        return result.canceled ? null : result.filePaths
    })

    // Dependencies
    ipcMain.handle('app:get-missing-dependencies', async () => {
        const { DependencyService } = await import('../utils/DependencyService')
        const depService = DependencyService.getInstance()
        return await depService.getMissingDependencies()
    })

    ipcMain.handle('app:get-all-dependencies', async () => {
        const { DependencyService } = await import('../utils/DependencyService')
        const depService = DependencyService.getInstance()
        return await depService.getAllDependencies()
    })

    ipcMain.handle('app:run-setup-script', async () => {
        const { DependencyService } = await import('../utils/DependencyService')
        const depService = DependencyService.getInstance()
        return await depService.runSetupScript()
    })
}
