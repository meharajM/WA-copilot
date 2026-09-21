const DEFAULT_MAX_MODEL_BYTES = 200 * 1024 * 1024

export class BrowserAgentdSpeechError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'BrowserAgentdSpeechError'
    this.status = status
  }
}

export type SpeechDownloadProgress = (progress: number) => void

export interface BrowserAgentdSpeechClientOptions {
  origin?: string
  fetch?: typeof globalThis.fetch
  maxModelBytes?: number
}

const normaliseOrigin = (origin: string): string => {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid agentd origin')
  return url.origin
}

const readError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch { /* status is enough */ }
  return `Agentd speech model request failed (${response.status})`
}

async function readModelBlob(response: Response, maxBytes: number, onProgress?: SpeechDownloadProgress): Promise<Blob> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new BrowserAgentdSpeechError('Speech model is too large', 413)
  if (!response.body?.getReader) {
    const blob = await response.blob()
    if (blob.size > maxBytes) throw new BrowserAgentdSpeechError('Speech model is too large', 413)
    onProgress?.(100)
    return blob
  }
  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!next.value) continue
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new BrowserAgentdSpeechError('Speech model is too large', 413)
      }
      chunks.push(next.value as unknown as BlobPart)
      if (declared > 0) onProgress?.(Math.min(100, total / declared * 100))
    }
  } finally {
    reader.releaseLock()
  }
  onProgress?.(100)
  return new Blob(chunks, { type: response.headers.get('content-type') || 'application/zip' })
}

export function createBrowserAgentdSpeechClient(options: BrowserAgentdSpeechClientOptions = {}) {
  const locationOrigin = typeof window !== 'undefined' && typeof window.location?.origin === 'string' ? window.location.origin : null
  const origin = normaliseOrigin(options.origin || locationOrigin || 'http://127.0.0.1')
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis)
  const maxBytes = options.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES
  const fetchModel = async (modelId: string, onProgress?: SpeechDownloadProgress): Promise<Blob> => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(modelId)) throw new Error('Invalid speech model ID')
    const response = await fetcher(new URL(`/api/v1/speech/models/${encodeURIComponent(modelId)}`, `${origin}/`).toString(), {
      credentials: 'include',
      headers: { accept: 'application/zip, application/octet-stream' },
    })
    if (!response.ok) throw new BrowserAgentdSpeechError(await readError(response), response.status || 500)
    const digest = response.headers.get('x-content-digest') || ''
    if (!/^sha-256=[a-f0-9]{64}$/i.test(digest)) throw new Error('Invalid speech model integrity metadata')
    return readModelBlob(response, maxBytes, onProgress)
  }
  return { fetchModel }
}

let singleton: ReturnType<typeof createBrowserAgentdSpeechClient> | null = null
export const getBrowserAgentdSpeechClient = (): ReturnType<typeof createBrowserAgentdSpeechClient> => {
  singleton ??= createBrowserAgentdSpeechClient()
  return singleton
}
export const resetBrowserAgentdSpeechClientForTests = (): void => { singleton = null }
