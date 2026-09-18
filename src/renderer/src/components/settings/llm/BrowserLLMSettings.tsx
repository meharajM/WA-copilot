import { useEffect, useState } from 'react'
import { CheckCircle, Cpu, Download, Loader2, Trash2 } from 'lucide-react'
import { ProviderCard } from './ProviderCard'
import { useSettingsStore } from '../../../stores/settingsStore'
import {
  WEBLLM_MODELS,
  checkDownloadedWebLLMModels,
  deleteWebLLMModel,
  downloadWebLLMModelOnly,
  getWebLLMStatus,
  subscribeToWebLLMStatus,
} from '../../../lib/webllm'

interface BrowserLLMSettingsProps {
  available?: boolean
  error?: string
  checking?: boolean
  onRefresh: () => void
}

export function BrowserLLMSettings({ available, error, checking, onRefresh }: BrowserLLMSettingsProps) {
  const settings = useSettingsStore()
  const [downloaded, setDownloaded] = useState<string[]>(getWebLLMStatus().downloadedModels)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    void checkDownloadedWebLLMModels()
    return subscribeToWebLLMStatus((status) => {
      setDownloaded(status.downloadedModels)
      setProgress(status.backgroundDownload?.progress ?? status.loadingProgress)
    })
  }, [])

  const handleDownload = async (modelId: string) => {
    setDownloading(modelId)
    try {
      await downloadWebLLMModelOnly(modelId)
      await checkDownloadedWebLLMModels()
      const status = getWebLLMStatus()
      if (!status.downloadedModels.includes(modelId)) {
        throw new Error(status.error || 'The model was not cached successfully')
      }
      setDownloaded(getWebLLMStatus().downloadedModels)
      settings.setBrowserModel(modelId)
    } catch (downloadError) {
      console.warn('[BrowserLLMSettings] Model download failed:', downloadError)
      onRefresh()
    } finally {
      setDownloading(null)
    }
  }

  const handleDelete = async (modelId: string) => {
    if (!window.confirm(`Delete ${modelId} from this browser?`)) return
    try {
      await deleteWebLLMModel(modelId)
      setDownloaded(getWebLLMStatus().downloadedModels.filter((id) => id !== modelId))
    } catch (deleteError) {
      console.warn('[BrowserLLMSettings] Model deletion failed:', deleteError)
    }
  }

  return (
    <ProviderCard
      title="On-Device (WebGPU)"
      status={{ available: Boolean(available), ...(error ? { error } : {}) }}
      checking={checking}
      headerActions={(
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="px-2 py-1 text-xs bg-[var(--color-surface)] hover:bg-[var(--color-border)] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Refresh WebGPU status"
        >
          ↻
        </button>
      )}
    >
      <div className="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
        <Cpu size={18} className="mt-0.5 shrink-0" />
        <span>Run a downloaded model in Edge/Chrome WebGPU. Model bytes stay in this browser profile.</span>
      </div>
      <div className="space-y-2">
        {WEBLLM_MODELS.map((model) => {
          const isDownloaded = downloaded.includes(model.id)
          const isSelected = settings.browserModel === model.id
          const isDownloading = downloading === model.id
          return (
            <div key={model.id} className={`rounded-lg border p-3 ${isSelected ? 'border-[var(--color-brand-teal)]' : 'border-[var(--color-border)]'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-[var(--color-text-primary)]">{model.name}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">{model.description} · {model.size} · {model.vram} VRAM</p>
                </div>
                {isDownloaded && <CheckCircle size={16} className="text-[var(--color-success)]" />}
              </div>
              {isDownloading && <p className="mt-2 text-xs text-[var(--color-brand-teal)]"><Loader2 size={12} className="mr-1 inline animate-spin" />Downloading {Math.round(progress)}%</p>}
              <div className="mt-2 flex gap-2">
                {isDownloaded ? (
                  <>
                    <button type="button" onClick={() => settings.setBrowserModel(model.id)} className="rounded bg-[var(--color-brand-teal)]/10 px-2 py-1 text-xs text-[var(--color-brand-teal)]">{isSelected ? 'Active model' : 'Use model'}</button>
                    {!isSelected && <button type="button" onClick={() => void handleDelete(model.id)} aria-label={`Delete ${model.name}`} className="rounded p-1 text-red-300"><Trash2 size={14} /></button>}
                  </>
                ) : (
                  <button type="button" onClick={() => void handleDownload(model.id)} disabled={Boolean(downloading)} className="flex items-center gap-1 rounded bg-[var(--color-brand-teal)]/10 px-2 py-1 text-xs text-[var(--color-brand-teal)] disabled:opacity-50"><Download size={14} />Download</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </ProviderCard>
  )
}
