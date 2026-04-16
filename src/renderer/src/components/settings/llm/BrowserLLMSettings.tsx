import React, { useState, useEffect } from 'react'
import { Download, CheckCircle, Trash2, Cpu, AlertCircle, Loader2 } from 'lucide-react'
import { ProviderCard } from './ProviderCard'
import { useSettingsStore } from '../../../stores/settingsStore'
import { 
    WEBLLM_MODELS, 
    WebLLMModelId, 
    getWebLLMStatus, 
    checkDownloadedWebLLMModels, 
    deleteWebLLMModel, 
    downloadWebLLMModelOnly, 
    subscribeToWebLLMStatus,
    checkWebLLMModelCompatibility
} from '../../../lib/webllm'

interface BrowserLLMSettingsProps {
    available?: boolean
    error?: string
    checking?: boolean
    onRefresh: () => void
}

export function BrowserLLMSettings({ available = false, error, checking, onRefresh }: BrowserLLMSettingsProps) {
    const settings = useSettingsStore()
    const [downloadedModels, setDownloadedModels] = useState<string[]>([])
    const [downloadStatus, setDownloadStatus] = useState<{
        isDownloading: boolean;
        progress: number;
        modelId: string | null;
        stage: string;
    }>({ isDownloading: false, progress: 0, modelId: null, stage: '' })
    const [compatibilities, setCompatibilities] = useState<Record<string, { compatible: boolean, reasons: string[] }>>({})

    useEffect(() => {
        // Initial check
        checkDownloadedWebLLMModels()
        
        // Check model compatibility (async)
        Promise.all(WEBLLM_MODELS.map(async (model) => {
            try {
                const result = await checkWebLLMModelCompatibility(model.id)
                return { id: model.id, result }
            } catch (err) {
                return { id: model.id, result: { compatible: false, reasons: ['Error checking compatibility'] } }
            }
        })).then(results => {
            const map: Record<string, { compatible: boolean, reasons: string[] }> = {}
            for (const r of results) {
                map[r.id] = r.result
            }
            setCompatibilities(map)
        })

        // Subscription to WebLLM status for reactive UI
        const unsubscribe = subscribeToWebLLMStatus((status) => {
            setDownloadedModels(status.downloadedModels)
            if (status.backgroundDownload) {
                setDownloadStatus({
                    isDownloading: true,
                    progress: status.backgroundDownload.progress,
                    modelId: status.backgroundDownload.modelId,
                    stage: status.backgroundDownload.stage || 'Downloading...',
                })
            } else {
                setDownloadStatus({
                    isDownloading: false,
                    progress: 0,
                    modelId: null,
                    stage: '',
                })
            }
        })
        return unsubscribe
    }, [])

    const handleDownload = async (modelId: string) => {
        try {
            await downloadWebLLMModelOnly(modelId)
        } catch (err) {
            console.error('Failed to download model:', err)
            onRefresh()
        }
    }

    const handleDelete = async (modelId: string) => {
        if (window.confirm(`Are you sure you want to delete ${modelId}?`)) {
            try {
                await deleteWebLLMModel(modelId)
                if (settings.browserModel === modelId) {
                    settings.setBrowserModel('')
                }
            } catch (err) {
                console.error('Failed to delete model:', err)
            }
        }
    }

    return (
        <ProviderCard
            title="On-Device (WebGPU)"
            icon={<Cpu size={24} />}
            available={available}
            checking={checking}
            error={error}
            onRetry={onRefresh}
        >
            <div className="space-y-4">
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                    Run LLMs entirely in your browser using local GPU compute. No internet required after initial download.
                    Perfect for complete privacy.
                </p>

                <div className="grid gap-4">
                    {WEBLLM_MODELS.map(model => {
                        const isDownloaded = downloadedModels.includes(model.id)
                        const isDownloading = downloadStatus.isDownloading && downloadStatus.modelId === model.id
                        const isSelected = settings.browserModel === model.id
                        const compat = compatibilities[model.id] || { compatible: true, reasons: [] }

                        return (
                            <div 
                                key={model.id}
                                className={`border rounded-lg p-4 transition-all ${
                                    isSelected 
                                    ? 'border-[var(--color-brand-teal)] bg-[var(--color-brand-teal)]/5' 
                                    : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                                }`}
                            >
                                <div className="flex justify-between items-start mb-2">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-bold text-[var(--color-text-primary)]">{model.name}</h4>
                                            {isDownloaded && <CheckCircle size={16} className="text-[#25D366]" title="Downloaded" />}
                                            {isSelected && <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--color-brand-teal)] text-white uppercase">Active</span>}
                                        </div>
                                        <p className="text-xs text-[var(--color-text-muted)] mt-1">{model.description}</p>
                                    </div>
                                    <div className="text-right text-xs text-[var(--color-text-dim)]">
                                        <p>Size: {model.size}</p>
                                        <p>VRAM: {model.vram}</p>
                                    </div>
                                </div>
                                
                                {!compat.compatible && !isDownloaded && (
                                    <div className="flex items-start gap-2 mt-3 p-2 bg-[#F5A623]/10 text-[#F5A623] rounded-md text-xs">
                                        <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                        <span>May run poorly: {compat.reasons.join(', ')}</span>
                                    </div>
                                )}

                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 mr-4">
                                        {isDownloading ? (
                                            <div className="space-y-1">
                                                <div className="flex justify-between text-xs text-[var(--color-brand-teal)] font-medium">
                                                    <span>{downloadStatus.stage}</span>
                                                    <span>{Math.round(downloadStatus.progress)}%</span>
                                                </div>
                                                <div className="w-full bg-[var(--color-border)] rounded-full h-1.5 overflow-hidden">
                                                    <div 
                                                        className="bg-[var(--color-brand-teal)] h-1.5 rounded-full transition-all duration-300" 
                                                        style={{ width: `${downloadStatus.progress}%` }}
                                                    ></div>
                                                </div>
                                            </div>
                                        ) : isDownloaded ? (
                                            <p className="text-xs text-[#25D366] font-medium flex items-center gap-1">
                                                <CheckCircle size={12} /> Ready for offline use
                                            </p>
                                        ) : (
                                            <p className="text-xs text-[var(--color-text-dim)]">Requires one-time download</p>
                                        )}
                                    </div>

                                    <div className="flex gap-2">
                                        {isDownloaded ? (
                                            <>
                                                <button
                                                    onClick={() => settings.setBrowserModel(model.id)}
                                                    className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                                                        isSelected 
                                                        ? 'bg-[var(--color-brand-teal)] text-white' 
                                                        : 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)]'
                                                    }`}
                                                >
                                                    {isSelected ? 'Active Model' : 'Set as Active'}
                                                </button>
                                                {!isSelected && (
                                                    <button
                                                        onClick={() => handleDelete(model.id)}
                                                        className="p-1.5 text-red-400 hover:text-red-500 hover:bg-red-400/10 rounded-lg transition-colors"
                                                        title="Delete model"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                )}
                                            </>
                                        ) : (
                                            <button
                                                onClick={() => handleDownload(model.id)}
                                                disabled={isDownloading}
                                                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors
                                                    ${isDownloading 
                                                    ? 'bg-[var(--color-surface)] text-[var(--color-text-dim)] cursor-not-allowed' 
                                                    : 'bg-[var(--color-brand-teal)]/10 text-[var(--color-brand-teal)] hover:bg-[var(--color-brand-teal)]/20'
                                                    }`}
                                            >
                                                {isDownloading ? (
                                                    <Loader2 size={14} className="animate-spin" />
                                                ) : (
                                                    <Download size={14} />
                                                )}
                                                {isDownloading ? 'Downloading...' : '1-Click Install'}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </ProviderCard>
    )
}
