import { ipcMain } from 'electron'
import * as path from 'path'
import { is } from '@electron-toolkit/utils'
import { ModelManager } from '../services/ModelManager'

function getBaseModelsDir(): string {
    if (is.dev) {
        return path.join(process.cwd(), 'public', 'models')
    }
    return path.join(process.resourcesPath, 'models')
}

let modelManager: ModelManager | null = null
const DEFAULT_MODEL_NAME = 'vosk-model-small-en-us-0.15'
const DEFAULT_MODEL_META = {
    id: 'en-us',
    name: 'English (US)',
    modelName: 'vosk-model-small-en-us-0.15',
    lang: 'en-US',
}

type ApprovedModel = { id: string; url: string; modelName: string; sha256?: string }
const APPROVED_MODELS = new Map<string, ApprovedModel>([
    ['en-us', { ...DEFAULT_MODEL_META, url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip', sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498' }],
    ['en-in', { id: 'en-in', url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip', modelName: 'vosk-model-small-en-in-0.4' }],
    ['zh-cn', { id: 'zh-cn', url: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip', modelName: 'vosk-model-small-cn-0.22' }],
    ['ja', { id: 'ja', url: 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip', modelName: 'vosk-model-small-ja-0.22' }],
    ['fr', { id: 'fr', url: 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip', modelName: 'vosk-model-small-fr-0.22' }],
    ['de', { id: 'de', url: 'https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip', modelName: 'vosk-model-small-de-0.15' }],
    ['es', { id: 'es', url: 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip', modelName: 'vosk-model-small-es-0.42' }],
    ['it', { id: 'it', url: 'https://alphacephei.com/vosk/models/vosk-model-small-it-0.22.zip', modelName: 'vosk-model-small-it-0.22' }],
    ['hi', { id: 'hi', url: 'https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip', modelName: 'vosk-model-small-hi-0.22' }],
])

function approvedModel(modelId?: unknown): ApprovedModel | undefined {
    if (modelId === undefined) return APPROVED_MODELS.get('en-us')
    return typeof modelId === 'string' ? APPROVED_MODELS.get(modelId) : undefined
}

export function registerSpeechHandlers(): void {
    // Initialize manager
    modelManager = new ModelManager(getBaseModelsDir())

    ipcMain.handle('speech:check-support', async (_event, modelId?: unknown) => {
        const model = approvedModel(modelId)
        return model ? await modelManager!.checkSupport(model.modelName) : { modelDownloaded: false, nativeSupport: true }
    })

    ipcMain.handle('speech:initialize', async () => ({ success: true }))
    ipcMain.handle('speech:start-listening', async () => ({ success: true }))
    ipcMain.handle('speech:stop-listening', async () => ({ success: true }))

    ipcMain.handle('speech:download-model', async (event, options: { modelId: string }) => {
        const approved = typeof options?.modelId === 'string' ? APPROVED_MODELS.get(options.modelId) : undefined
        if (!approved) return { success: false, error: 'Speech model is not approved' }
        return await modelManager!.downloadModel(
            approved.modelName,
            approved.url,
            (progress) => {
                try {
                    event.sender.send('speech:download-progress', { modelId: options.modelId, progress })
                } catch { /* ignore */ }
            },
            approved.sha256
        )
    })

    ipcMain.handle('speech:get-model-path', async (_event, modelId: unknown) => {
        const model = approvedModel(modelId)
        return model ? await modelManager!.getModelPath(model.modelName) : null
    })

    ipcMain.handle('speech:get-preferred-model', async () => {
        return DEFAULT_MODEL_META
    })

    ipcMain.handle('speech:get-status', async (_event, modelId?: unknown) => {
        const model = approvedModel(modelId)
        if (!model) return { isInitialized: true, isListening: false, error: 'Speech model is not approved', modelsPath: getBaseModelsDir(), modelDownloaded: false }
        const support = await modelManager!.checkSupport(model.modelName || DEFAULT_MODEL_NAME)
        return {
            isInitialized: true,
            isListening: false,
            error: null,
            modelsPath: getBaseModelsDir(),
            modelDownloaded: support.modelDownloaded,
        }
    })

    ipcMain.handle('speech:cleanup', async () => {
        if (modelManager) {
            await modelManager.cleanup()
        }
        return { success: true }
    })

    // Cleanup when app quits
    ipcMain.handle('speech:cleanup-server', async () => {
        if (modelManager) {
            await modelManager.cleanup()
        }
        return { success: true }
    })
}
