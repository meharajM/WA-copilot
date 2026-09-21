import { useState, useCallback, useRef, useEffect } from 'react'
import { VOICE_CONFIG, VoskModel } from '../lib/constants'
import { useSettingsStore } from '../stores/settingsStore'
import { isElectron } from '../lib/electron'
import { voskService } from '../lib/vosk'
import { getBrowserAgentdSpeechClient } from '../lib/browser-agentd-speech'
import { useLogStore } from '../stores/logStore'
import { useChatStore } from '../stores/chatStore'
import {
    browserSpeechErrorMessage,
    browserSpeechRecognitionSupported,
    browserSpeechShouldRestart,
    getBrowserSpeechRecognitionConstructor,
} from '../lib/speech-capabilities'

interface UseSpeechRecognitionReturn {
    isListening: boolean
    transcript: string
    interimTranscript: string
    error: string | null
    isSupported: boolean
    isNativeSupported: boolean
    isInitializing: boolean
    startListening: () => void
    stopListening: () => void
    resetTranscript: () => void
    audioLevel: number
    isFirstSetup: boolean
    setupProgress: number
    notification: string | null
    setText: (text: string) => void
    currentModel: VoskModel | null
}

export function useSpeechRecognition(): UseSpeechRecognitionReturn {
    const settings = useSettingsStore()
    const useNativeSpeech = isElectron()
    const useVoskSpeech = useNativeSpeech || (!useNativeSpeech && (settings.offlineSpeech || !browserSpeechRecognitionSupported()))
    const { addLog } = useLogStore()

    const [isListening, setIsListening] = useState(false)
    const [transcript, setTranscript] = useState('')
    const [interimTranscript, setInterimTranscript] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [isSupported, setIsSupported] = useState(false)
    const [audioLevel, setAudioLevel] = useState(0)
    const [isInitializing, setIsInitializing] = useState(false)
    const [isFirstSetup, setIsFirstSetup] = useState(false)
    const [setupProgress, setSetupProgress] = useState(0)
    const [notification, setNotification] = useState<string | null>(null)
    const [currentModel, setCurrentModel] = useState<VoskModel | null>(null)

    // Track intent to prevent race conditions during async setup
    const shouldListenRef = useRef(false)

    // Refs for Web Speech API
    const recognitionRef = useRef<SpeechRecognition | null>(null)
    const browserRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Refs for WASM / Audio
    const visMediaStreamRef = useRef<MediaStream | null>(null)
    const visAudioContextRef = useRef<AudioContext | null>(null)
    const visAnimationFrameRef = useRef<number | null>(null)
    const visProcessorRef = useRef<ScriptProcessorNode | null>(null)

    // Initialize: Select Model based on settings
    useEffect(() => {
        if (useVoskSpeech) {
            const preferredModelId = settings.voskModel || 'auto'

            if (preferredModelId === 'auto') {
                // Auto-detect: Use default model for now (in future could detect system locale)
                const defaultModel = VOICE_CONFIG.VOSK_MODELS.find(m => m.id === VOICE_CONFIG.DEFAULT_MODEL_ID)
                    || VOICE_CONFIG.VOSK_MODELS[0]
                console.log('[Speech] Using default model (Auto):', defaultModel)
                setCurrentModel(defaultModel)
            } else {
                // Manual selection - Find in VOICE_CONFIG
                const selected = VOICE_CONFIG.VOSK_MODELS.find(m => m.id === preferredModelId)

                if (selected) {
                    console.log('[Speech] Using selected model:', selected)
                    setCurrentModel(selected)
                } else {
                    console.warn('[Speech] Selected model not found, falling back to default')
                    const defaultModel = VOICE_CONFIG.VOSK_MODELS[0]
                    setCurrentModel(defaultModel)
                }
            }
        }
    }, [useVoskSpeech, settings.voskModel])

    // Check Web Speech API support in browser
    useEffect(() => {
        if (!useVoskSpeech) {
            if (browserSpeechRecognitionSupported()) {
                setIsSupported(true)
                console.log('[Speech] Web Speech API supported')
            } else {
                setIsSupported(false)
                console.warn('[Speech] Web Speech API not supported in this browser')
            }
        } else {
            // Vosk runs locally with a model supplied by Electron or agentd.
            setIsSupported(true)
        }
    }, [useVoskSpeech])

    // Initialize Web Speech API recognition instance
    useEffect(() => {
        if (useNativeSpeech) return // Electron owns speech through Vosk

        const SpeechRecognitionAPI = getBrowserSpeechRecognitionConstructor()
        if (!SpeechRecognitionAPI) return

        let recognition: SpeechRecognition
        try {
            recognition = new SpeechRecognitionAPI()
        } catch (error) {
            console.warn('[Speech] Browser speech initialization failed:', error)
            setIsSupported(false)
            setError(browserSpeechErrorMessage(error, settings.speechLang || VOICE_CONFIG.SPEECH_LANG))
            return
        }
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = settings.speechLang || VOICE_CONFIG.SPEECH_LANG

        recognition.onresult = (event: any) => {
            let finalTranscript = ''
            let interimResult = ''

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i]
                if (result.isFinal) {
                    finalTranscript += result[0].transcript
                } else {
                    interimResult += result[0].transcript
                }
            }

            if (finalTranscript) {
                setTranscript((prev) => prev + finalTranscript + ' ')
            }
            setInterimTranscript(interimResult)
        }

        recognition.onerror = (event) => {
            console.error('[Speech] Web Speech API error:', event.error)
            if (event.error !== 'no-speech' && event.error !== 'aborted') {
                setError(browserSpeechErrorMessage(event, recognition.lang))
            }
            if (!browserSpeechShouldRestart(event)) {
                shouldListenRef.current = false
            }
            if (!shouldListenRef.current) setIsListening(false)
        }

        recognition.onend = () => {
            if (!shouldListenRef.current) {
                setIsListening(false)
                return
            }

            // Chrome/Edge end continuous recognition periodically. Restart with
            // a short delay, but avoid a tight loop when the browser rejects it.
            if (browserRestartTimerRef.current !== null) return
            browserRestartTimerRef.current = setTimeout(() => {
                browserRestartTimerRef.current = null
                if (!shouldListenRef.current) return
                try {
                    recognition.start()
                    setIsListening(true)
                } catch (error) {
                    console.warn('[Speech] Recognition restart failed:', error)
                    shouldListenRef.current = false
                    setIsListening(false)
                    setError(browserSpeechErrorMessage(error, recognition.lang))
                }
            }, 100)
        }

        recognitionRef.current = recognition

        return () => {
            // Abort from cleanup must never be mistaken for a user-requested
            // continuous session by the old recognition instance.
            shouldListenRef.current = false
            if (browserRestartTimerRef.current !== null) {
                clearTimeout(browserRestartTimerRef.current)
                browserRestartTimerRef.current = null
            }
            if (recognitionRef.current) {
                recognitionRef.current.abort()
                recognitionRef.current = null
            }
        }
    }, [useNativeSpeech, settings.speechLang])


    // Setup IPC listeners for Download Progress
    useEffect(() => {
        if (useVoskSpeech) {
            const electron = (window as any).electron
            if (!electron) return

            const removeProgressListener = electron.speech.onDownloadProgress((data: { modelId: string, progress: number }) => {
                setSetupProgress(data.progress)
            })
            return () => {
                removeProgressListener?.()
            }
        }
    }, [useNativeSpeech])

    // Cleanup on unmount

    // Auto-clear notification
    useEffect(() => {
        if (notification) {
            const timer = setTimeout(() => setNotification(null), 3000)
            return () => clearTimeout(timer)
        }
    }, [notification])

    const startVisualization = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                    channelCount: 1,
                }
            })
            visMediaStreamRef.current = stream
 
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 16000
            })
            visAudioContextRef.current = audioContext
 
            if (audioContext.state === 'suspended') {
                await audioContext.resume()
            }
 
            const source = audioContext.createMediaStreamSource(stream)
 
            if (useVoskSpeech) {
                // Reset recognizer to clear any previous listeners from prior toggle
                voskService.resetRecognizer()
                const recognizer = voskService.getRecognizer()
                if (!recognizer) {
                    console.error('Recognizer not ready')
                    return
                }
 
                recognizer.on('result', (message: any) => {
                    const text = message.result?.text
                    if (text) {
                        setTranscript((prev) => prev + text + ' ')
                        setInterimTranscript('')
                    }
                })

                recognizer.on('partialresult', (message: any) => {
                    const partial = message.result?.partial
                    if (partial) {
                        setInterimTranscript(partial)
                    }
                })
 
                const processor = audioContext.createScriptProcessor(4096, 1, 1)
                visProcessorRef.current = processor
 
                processor.onaudioprocess = (event) => {
                    try {
                        const buffer = event.inputBuffer
                        if (buffer.numberOfChannels > 0) {
                            recognizer.acceptWaveform(event.inputBuffer)
                        }
                    } catch (err: unknown) {
                        console.error('WASM processing error:', err)
                    }
                }
 
                source.connect(processor)
 
                // CRITICAL: Processor MUST be connected to destination for the audio clock to run in Chrome/Electron
                // We connect via a GainNode with 0 gain to prevent feedback (hearing yourself)
                const muteNode = audioContext.createGain()
                muteNode.gain.value = 0
                processor.connect(muteNode)
                muteNode.connect(audioContext.destination)
            }
 
            const analyser = audioContext.createAnalyser()
            analyser.fftSize = 256
            source.connect(analyser)
 
            const dataArray = new Uint8Array(analyser.frequencyBinCount)
            const updateVolume = () => {
                if (!visAudioContextRef.current) return
                analyser.getByteFrequencyData(dataArray)
                let sum = 0
                for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]
                const average = sum / dataArray.length
                setAudioLevel(Math.min(1, average / 40))
                visAnimationFrameRef.current = requestAnimationFrame(updateVolume)
            }
            updateVolume()
        } catch (err: unknown) {
            console.warn('[Speech] Audio setup failed:', err)
            setError('Microphone initialization failed')
            setIsListening(false)
        }
    }, [useVoskSpeech])

    const stopVisualization = useCallback(() => {
        if (visProcessorRef.current) {
            visProcessorRef.current.disconnect()
            visProcessorRef.current = null
        }
        if (visAnimationFrameRef.current) {
            cancelAnimationFrame(visAnimationFrameRef.current)
            visAnimationFrameRef.current = null
        }
        if (visMediaStreamRef.current) {
            visMediaStreamRef.current.getTracks().forEach(track => track.stop())
            visMediaStreamRef.current = null
        }
        if (visAudioContextRef.current) {
            visAudioContextRef.current.close().catch(console.error)
            visAudioContextRef.current = null
        }
        setAudioLevel(0)
    }, [])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopVisualization()
        }
    }, [stopVisualization])

    const startListening = useCallback(async () => {
        if (isListening || isInitializing) return

        shouldListenRef.current = true
        setError(null)
        setNotification(null)
        // Do NOT clear transcript here - allows appending to manual edits
        setInterimTranscript('')

        const sessionId = useChatStore.getState().activeSessionId || 'unknown'

        addLog({
            eventType: 'STATE_CHANGE',
            sessionId,
            component: 'useSpeechRecognition',
            details: { metadata: { state: 'initializing', useNativeSpeech, model: currentModel?.name } }
        })

        if (useVoskSpeech) {
            setIsInitializing(true)
            try {
                // Wait for model config if not yet loaded (though useEffect should have fired)
                let targetModel = currentModel
                if (!targetModel) {
                    console.warn('[Speech] currentModel is null in startListening, resolving fallback...')
                    const preferredModelId = settings.voskModel || 'auto'
                    if (preferredModelId === 'auto') {
                        targetModel = VOICE_CONFIG.VOSK_MODELS.find(m => m.id === VOICE_CONFIG.DEFAULT_MODEL_ID)
                            || VOICE_CONFIG.VOSK_MODELS[0]
                    } else {
                        targetModel = VOICE_CONFIG.VOSK_MODELS.find(m => m.id === preferredModelId)
                            || VOICE_CONFIG.VOSK_MODELS[0]
                    }
                    setCurrentModel(targetModel)
                }

                if (!targetModel) throw new Error("Could not determine speech model")

                const modelId = targetModel.id
                const modelName = targetModel.modelName

                if (useNativeSpeech) {
                    const electron = (window as any).electron
                    const check = await electron.speech.checkSupport(modelId)
                    if (!shouldListenRef.current) return
                    if (!check.modelDownloaded) {
                        setIsFirstSetup(true)
                        setSetupProgress(0)
                        addLog({ eventType: 'SYSTEM_INIT', sessionId, component: 'useSpeechRecognition', details: { metadata: { action: 'download_model_start', model: modelName } } })
                        const result = await electron.speech.downloadModel({ modelId })
                        if (!result.success) throw new Error(result.error)
                        addLog({ eventType: 'SYSTEM_INIT', sessionId, component: 'useSpeechRecognition', details: { metadata: { action: 'download_model_complete', success: true } } })
                        setIsFirstSetup(false)
                        setIsInitializing(false)
                        shouldListenRef.current = false
                        setNotification(`Voice model (${targetModel.name}) ready! Click Mic to start.`)
                        return
                    }
                    if (!shouldListenRef.current) return
                    if (!voskService.isReady()) {
                        const modelPath = await electron.speech.getModelPath(modelId)
                        if (!modelPath) throw new Error('Model path not available')
                        await voskService.loadModel(modelPath)
                    }
                } else if (!voskService.isReady()) {
                    setIsFirstSetup(true)
                    setSetupProgress(0)
                    const modelBlob = await getBrowserAgentdSpeechClient().fetchModel(modelId, progress => setSetupProgress(progress))
                    if (!shouldListenRef.current) return
                    await voskService.loadModelFromBlob(modelBlob)
                }

                if (!shouldListenRef.current) return

                setIsListening(true)
                setIsFirstSetup(false)
                addLog({ eventType: 'STATE_CHANGE', sessionId, component: 'useSpeechRecognition', details: { metadata: { state: 'listening_started', method: useNativeSpeech ? 'native' : 'browser_vosk', model: modelName } } })
                await startVisualization()

            } catch (e: any) {
                setIsFirstSetup(false)
                if (!shouldListenRef.current) return
                // Browser Vosk is optional: retain Web Speech fallback when model
                // acquisition or WASM initialization is unavailable.
                if (!useNativeSpeech && recognitionRef.current) {
                    try {
                        recognitionRef.current.lang = settings.speechLang || VOICE_CONFIG.SPEECH_LANG
                        recognitionRef.current.start()
                        setIsListening(true)
                        setNotification('Offline voice model unavailable; using browser speech recognition.')
                        addLog({ eventType: 'STATE_CHANGE', sessionId, component: 'useSpeechRecognition', details: { metadata: { state: 'listening_started', method: 'web_speech_fallback' } } })
                        return
                    } catch (fallbackError: any) {
                        e = fallbackError
                    }
                }
                console.error('[Speech] Start failed:', e)
                setError(`Setup failed: ${e?.message || String(e)}`)
                setIsListening(false)
                addLog({ eventType: 'ERROR', sessionId, component: 'useSpeechRecognition', details: { error: e?.message || String(e) } })
            } finally {
                if (shouldListenRef.current) setIsInitializing(false)
            }
        } else {
            // Web Speech API fallback
            if (!recognitionRef.current) {
                shouldListenRef.current = false
                setIsListening(false)
                setError('Browser speech recognition is not supported in this browser. Use text input.')
                return
            }
            try {
                recognitionRef.current.lang = settings.speechLang || VOICE_CONFIG.SPEECH_LANG
                recognitionRef.current.start()
                setIsListening(true)
                addLog({
                    eventType: 'STATE_CHANGE',
                    sessionId,
                    component: 'useSpeechRecognition',
                    details: { metadata: { state: 'listening_started', method: 'web_speech' } }
                })
            } catch (e: any) {
                console.error('[Speech] Failed to start Web Speech API:', e)
                shouldListenRef.current = false
                setIsListening(false)
                setError(browserSpeechErrorMessage(e, settings.speechLang || VOICE_CONFIG.SPEECH_LANG))
            }
        }
    }, [isListening, isInitializing, useVoskSpeech, useNativeSpeech, addLog, currentModel, settings.voskModel, settings.speechLang, startVisualization])

    const stopListening = useCallback(async () => {
        const sessionId = useChatStore.getState().activeSessionId || 'unknown'
        addLog({ eventType: 'STATE_CHANGE', sessionId, component: 'useSpeechRecognition', details: { metadata: { state: 'listening_stopped' } } })

        shouldListenRef.current = false
        if (useNativeSpeech) {
            setIsListening(false)
            setIsInitializing(false)
            stopVisualization()
        } else {
            if (browserRestartTimerRef.current !== null) {
                clearTimeout(browserRestartTimerRef.current)
                browserRestartTimerRef.current = null
            }
            if (recognitionRef.current) {
                try {
                    recognitionRef.current.stop()
                } catch (error) {
                    console.debug('[Speech] Recognition was already stopped:', error)
                }
            }
            setIsListening(false)
            stopVisualization()
        }
    }, [useVoskSpeech, addLog, stopVisualization])

    const resetTranscript = useCallback(() => {
        setTranscript('')
        setInterimTranscript('')
    }, [])

    const setText = useCallback((text: string) => {
        setTranscript(text)
        setInterimTranscript('')
    }, [])

    return {
        isListening,
        transcript,
        interimTranscript,
        error,
        notification,
        isSupported,
        isNativeSupported: useNativeSpeech,
        isInitializing,
        startListening,
        stopListening,
        resetTranscript,
        setText, // Exported
        audioLevel,
        isFirstSetup,
        setupProgress,
        currentModel
    }
}
