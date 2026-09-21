import { createModel, type KaldiRecognizer, type Model } from 'vosk-browser'

interface VoskServiceState {
    model: Model | null
    recognizer: KaldiRecognizer | null
    currentModelUrl: string | null
    isReady: boolean
    isLoading: boolean
    error: string | null
    ownsCurrentModelUrl: boolean
}

class VoskService {
    private static instance: VoskService
    private state: VoskServiceState = {
        model: null,
        recognizer: null,
        currentModelUrl: null,
        isReady: false,
        isLoading: false,
        error: null,
        ownsCurrentModelUrl: false,
    }

    // Config
    private sampleRate = 16000

    private constructor() { }

    static getInstance(): VoskService {
        if (!VoskService.instance) {
            VoskService.instance = new VoskService()
        }
        return VoskService.instance
    }

    async loadModelFromBlob(blob: Blob): Promise<void> {
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('Blob URLs are not supported in this browser')
        const modelUrl = URL.createObjectURL(blob)
        try {
            await this.loadModel(modelUrl)
            this.state.ownsCurrentModelUrl = true
        } catch (error) {
            URL.revokeObjectURL(modelUrl)
            throw error
        }
    }

    async loadModel(modelUrl: string): Promise<void> {
        // If same model already loaded, skip
        if (this.state.model && this.state.currentModelUrl === modelUrl) {
            console.log('[Vosk WASM] Model already loaded:', modelUrl)
            return
        }

        // If different model or not loaded, free existing first
        if (this.state.model) {
            console.log('[Vosk WASM] Switching models, freeing current model first...')
            this.free()
        }

        try {
            console.log('[Vosk WASM] Loading model from:', modelUrl)
            this.state.isLoading = true
            this.state.currentModelUrl = modelUrl

            // vosk-browser creates a model from a URL (zip or folder structure)
            const model = await createModel(modelUrl)

            this.state.model = model
            this.state.recognizer = new model.KaldiRecognizer(this.sampleRate)

            this.state.isReady = true
            this.state.isLoading = false
            console.log('[Vosk WASM] Model loaded successfully')
        } catch (error) {
            console.error('[Vosk WASM] Failed to load model:', error)
            this.state.error = String(error)
            this.state.isLoading = false
            this.state.currentModelUrl = null
            this.state.ownsCurrentModelUrl = false
            throw error
        }
    }

    public getRecognizer(): KaldiRecognizer | null {
        return this.state.recognizer
    }

    public resetRecognizer(): void {
        if (this.state.recognizer) {
            this.state.recognizer.remove()
            this.state.recognizer = null
        }
        if (this.state.model) {
            this.state.recognizer = new this.state.model.KaldiRecognizer(this.sampleRate)
        }
    }

    public free(): void {
        if (this.state.recognizer) {
            this.state.recognizer.remove()
            this.state.recognizer = null
        }
        if (this.state.model) {
            this.state.model.terminate()
            this.state.model = null
        }
        if (this.state.ownsCurrentModelUrl && this.state.currentModelUrl && typeof URL !== 'undefined') URL.revokeObjectURL(this.state.currentModelUrl)
        this.state.currentModelUrl = null
        this.state.ownsCurrentModelUrl = false
        this.state.isReady = false
    }

    public isReady(): boolean {
        return this.state.isReady && !!this.state.recognizer
    }
}

export const voskService = VoskService.getInstance()
