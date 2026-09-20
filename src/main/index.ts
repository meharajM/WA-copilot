import './bootstrap-env'
import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initEnv, __dirname } from './utils/env'
import { setupIpcHandlers } from './ipc'
import { McpProcessManager } from './services/McpProcessManager'
import { emailChannelService } from './services/EmailChannelService'
import { autonomousSupervisor } from './services/AutonomousSupervisor'
import { whatsappService } from './whatsapp/WhatsAppService'
import { whatsAppCloudWebhookServer } from './services/WhatsAppCloudWebhookServer'
import { MetaWebhookServer } from './services/MetaWebhookServer'
import type { MetaMessagingChannel } from './services/MetaMessaging'
import { XWebhookServer } from './services/XWebhookServer'
import { shouldAutoResume } from './services/AutonomyPolicy'
import { allowsBrowserExtensionMessage, BrowserExtensionBridge } from './services/BrowserExtensionBridge'
import Store from 'electron-store'
import { isSafeExternalUrl } from './utils/external-url'

const metaWebhookServer = new MetaWebhookServer(message => autonomousSupervisor.onMetaMessage(message), lead => autonomousSupervisor.recordMetaLead(lead), update => autonomousSupervisor.onDeliveryUpdate(update))
const xWebhookServer = new XWebhookServer(message => autonomousSupervisor.onMetaMessage(message))
const extensionSettings = new Store<Record<string, unknown>>({ name: 'aica-store', defaults: {} }) as Store<Record<string, unknown>> & { get: (key: string) => unknown }
const browserExtensionBridge = new BrowserExtensionBridge(
    message => autonomousSupervisor.onMessage(message),
    message => allowsBrowserExtensionMessage(message, {
        selectedTransport: process.env.WHATSAPP_TRANSPORT || extensionSettings.get('whatsapp_transport'),
        ...whatsappService.getConnectionState(),
    }),
)
autonomousSupervisor.attachExtensionBridge(browserExtensionBridge)


// Enable experimental on-device AI features (Gemini Nano / Chrome Prompt API)
// These flags attempt to enable the window.ai API in Electron's Chromium
app.commandLine.appendSwitch('enable-features',
    'PromptAPIForGeminiNano,' +
    'OptimizationGuideOnDeviceModel:bypass_perf_requirement/true,' +
    'LanguageDetectionAPI,' +
    'ExperimentalWebPlatformFeatures'  // Enables modern web APIs
)
app.commandLine.appendSwitch('optimization-guide-on-device-model-execution', 'performance_class:0')

// Enable Web Speech API in Electron
// These flags ensure speech recognition works properly
app.commandLine.appendSwitch('enable-speech-dispatcher')  // Linux speech support
app.commandLine.appendSwitch('enable-speech-input')       // Enable speech input
app.commandLine.appendSwitch('enable-experimental-web-platform-features')  // Web Speech API


// Initialize environment (fix PATH, etc.)
initEnv()

// PRODUCTION: Inject Google API Keys if available
// These are required for Web Speech API to work in built/packaged apps
// You must provide them via environment variables
if (process.env.GOOGLE_API_KEY) {
    // Already set in environment
}
if (process.env.GOOGLE_DEFAULT_CLIENT_ID) {
    // Already set in environment
}
if (process.env.GOOGLE_DEFAULT_CLIENT_SECRET) {
    // Already set in environment
}

function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 15, y: 15 },
        backgroundColor: '#0f1115',
        webPreferences: {
            preload: join(__dirname, '../preload/index.mjs'),
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
            // Keep Chromium's same-origin and mixed-content protections enabled.
            // Vosk models are served by the loopback-only model server.
        }
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow.show()
        if (is.dev) {
            mainWindow.webContents.openDevTools()
        }
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
        const url = details.url

        // Allow Firebase/Google OAuth popups to open in new window
        if (url.includes('accounts.google.com') ||
            url.includes('.firebaseapp.com') ||
            url.includes('googleapis.com')) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 500,
                    height: 600,
                    autoHideMenuBar: true,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                    }
                }
            }
        }

        // Open other external links in system browser
        if (isSafeExternalUrl(url)) shell.openExternal(url)
        return { action: 'deny' }
    })

    // Enable audio permissions for TTS/STT
    mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allowedPermissions = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'midi', 'midiSysex']
        if (allowedPermissions.includes(permission)) {
            callback(true)
        } else {
            callback(false)
        }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
}

app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.aica.app')

    // Verify environment and paths
    setupIpcHandlers()
    const previousAutonomy = autonomousSupervisor.getState()
    if (shouldAutoResume(previousAutonomy)) {
        const resumed = autonomousSupervisor.start()
        autonomousSupervisor.recover()
        console.log('[Autonomy] crash-safe startup resume', { status: resumed.status, paused: resumed.paused, queueDepth: resumed.queueDepth })
    }
    await whatsAppCloudWebhookServer.start()
    await browserExtensionBridge.start()
    const metaChannel = process.env.META_WEBHOOK_CHANNEL
    const metaVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN
    const metaAppSecret = process.env.META_APP_SECRET
    if ((metaChannel === 'instagram' || metaChannel === 'messenger') && metaVerifyToken && metaAppSecret) {
        const port = Number(process.env.META_WEBHOOK_PORT || 8788)
        await metaWebhookServer.start(metaChannel as MetaMessagingChannel, metaVerifyToken, metaAppSecret, port)
    }
    if (process.env.X_WEBHOOK_CONSUMER_SECRET) await xWebhookServer.start(process.env.X_WEBHOOK_CONSUMER_SECRET, Number(process.env.X_WEBHOOK_PORT || 8789), process.env.X_ACCOUNT_ID || '')

    // Workers cannot fetch file:// URLs easily. We serve the model over HTTP locally.
    // Check for production env explicitly to ensure it runs during e2e tests
    // (Server code removed due to hang - reverting to file access attempt)

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })

    createWindow()

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

let isQuitting = false
app.on('before-quit', async (event) => {
    if (isQuitting) return
    
    // Prevent default quit, cleanup, then quit
    event.preventDefault()
    isQuitting = true
    
    await emailChannelService.stop().catch(() => {})
    autonomousSupervisor.stop()
    await whatsAppCloudWebhookServer.stop()
    await metaWebhookServer.stop()
    await xWebhookServer.stop()
    await browserExtensionBridge.stop()
    await McpProcessManager.getInstance().teardownAll()
    
    app.quit()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// Handle certificate errors for local development
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    if (is.dev) {
        event.preventDefault()
        callback(true)
    } else {
        callback(false)
    }
})
