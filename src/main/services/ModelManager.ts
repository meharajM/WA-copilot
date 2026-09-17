import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { ModelServer } from './ModelServer'

export function validateModelArchiveEntries(entries: string[], expectedRoot?: string): void {
    for (const rawEntry of entries) {
        const entry = rawEntry.replaceAll('\\', '/').trim()
        if (entry.startsWith('/') || /^[a-z]:\//i.test(entry) || path.posix.normalize(entry).startsWith('../') || entry.includes('/../')) {
            throw new Error('Model archive contains an unsafe path')
        }
        if (expectedRoot && entry.split('/')[0] !== expectedRoot) throw new Error('Model archive contains an unexpected root')
    }
}

export function isSha256Digest(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value)
}

export function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const input = fs.createReadStream(filePath)
        input.on('data', chunk => hash.update(chunk))
        input.once('error', reject)
        input.once('end', () => resolve(hash.digest('hex')))
    })
}

export class ModelManager {
    private modelsDir: string
    private server: ModelServer

    constructor(modelsDir: string) {
        this.modelsDir = modelsDir
        this.server = new ModelServer(modelsDir)
    }

    private safeModelName(modelName: string): boolean {
        return /^[a-z0-9][a-z0-9.-]{0,120}$/i.test(modelName)
            && path.resolve(this.modelsDir, modelName).startsWith(`${path.resolve(this.modelsDir)}${path.sep}`)
    }

    private validateArchive(zipPath: string, modelName: string): void {
        const listing = process.platform === 'win32'
            ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$z=[IO.Compression.ZipFile]::OpenRead($args[0]); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()', zipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            : execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        const entries = listing
            .split(/\r?\n/)
            .map(entry => entry.trim())
            .filter(Boolean)
        validateModelArchiveEntries(entries, modelName)
    }

    public getModelsDir(): string {
        return this.modelsDir
    }

    public getModelDirPath(modelName: string): string {
        return path.join(this.modelsDir, modelName)
    }

    public async checkSupport(modelName: string = 'vosk-model-small-en-us-0.15'): Promise<{ modelDownloaded: boolean; nativeSupport: boolean }> {
        if (!this.safeModelName(modelName)) return { modelDownloaded: false, nativeSupport: true }
        const zipPath = path.join(this.modelsDir, `${modelName}.zip`)

        // Strict Check: Require ZIP file for vosk-browser
        const isDownloaded = fs.existsSync(zipPath)

        if (!isDownloaded) {
            console.log('[Speech] ZIP not found. Triggering re-download to ensure valid archive.')
        }

        return {
            modelDownloaded: isDownloaded,
            nativeSupport: true
        }
    }

    public async getModelPath(modelName: string): Promise<string | null> {
        if (!this.safeModelName(modelName)) return null
        const zipPath = path.join(this.modelsDir, `${modelName}.zip`)
        const modelPath = this.getModelDirPath(modelName)

        // Prefer ZIP file if it exists (required for vosk-browser createModel)
        if (fs.existsSync(zipPath)) {
            const baseUrl = await this.server.start()
            // Critical Fix: Ensure no spaces in URL
            return `${baseUrl}/${modelName}.zip`
        }

        // Fallback to directory
        if (fs.existsSync(modelPath)) {
            const baseUrl = await this.server.start()
            return `${baseUrl}/${modelName}`
        }

        return null
    }

    public async downloadModel(
        modelName: string,
        modelUrl: string, // New argument
        onProgress: (progress: number) => void,
        expectedSha256: string = ''
    ): Promise<{ success: boolean; error?: string }> {
        // Use provided URL, fallback if empty (though logic should ensure it's provided)
        if (!this.safeModelName(modelName)) return { success: false, error: 'Invalid model name' }
        let url: URL
        try { url = new URL(modelUrl) } catch { return { success: false, error: 'Invalid model URL' } }
        if (url.protocol !== 'https:' || url.hostname !== 'alphacephei.com') return { success: false, error: 'Model URL is not approved' }
        if (!isSha256Digest(expectedSha256)) return { success: false, error: 'Model integrity metadata is unavailable' }

        const zipPath = path.join(this.modelsDir, `${modelName}.zip`)
        const targetDir = this.getModelDirPath(modelName)

        if (!fs.existsSync(this.modelsDir)) {
            fs.mkdirSync(this.modelsDir, { recursive: true })
        }

        return new Promise((resolve) => {
            console.log(`[Speech] Downloading model ZIP from ${url}...`)
            const file = fs.createWriteStream(zipPath)
            let settled = false
            const failDownload = (error: string): void => {
                if (settled) return
                settled = true
                try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath) } catch { /* best-effort cleanup */ }
                resolve({ success: false, error })
            }

            https.get(url, (response) => {
                if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
                    response.resume()
                    file.destroy()
                    failDownload(`Model download failed with HTTP ${response.statusCode ?? 0}`)
                    return
                }
                response.on('error', (err) => failDownload(err.message))
                const totalSize = parseInt(response.headers['content-length'] || '0', 10)
                const maxSize = 100 * 1024 * 1024
                if (totalSize > maxSize) {
                    response.destroy()
                    file.destroy()
                    failDownload('Model download exceeds size limit')
                    return
                }
                let downloadedSize = 0

                response.on('data', (chunk) => {
                    downloadedSize += chunk.length
                    if (downloadedSize > maxSize) {
                        response.destroy()
                        file.destroy()
                        failDownload('Model download exceeds size limit')
                        return
                    }
                    if (totalSize > 0) {
                        const progress = (downloadedSize / totalSize) * 100
                        onProgress(progress)
                    }
                })

                response.pipe(file)

                file.on('finish', () => {
                    if (settled) return
                    file.close(async () => {
                        if (settled) return
                        console.log(`[Speech] Extracting model ZIP...`)
                        try {
                            const actualSha256 = await sha256File(zipPath)
                            if (actualSha256 !== expectedSha256.toLowerCase()) {
                                fs.unlinkSync(zipPath)
                                settled = true
                                resolve({ success: false, error: 'Model integrity check failed' })
                                return
                            }
                            this.validateArchive(zipPath, modelName)
                            // Extract to modelsDir
                            try {
                                // Critical Fix: Correct unzip command "unzip -o"
                                execFileSync('unzip', ['-o', zipPath, '-d', this.modelsDir], { stdio: 'ignore' })
                            } catch (e) {
                                if (process.platform === 'win32') {
                                    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zipPath, this.modelsDir], { stdio: 'ignore' })
                                } else {
                                    throw e
                                }
                            }

                            // Check extraction
                            if (fs.existsSync(targetDir)) {
                                console.log(`[Speech] Model ready at ${targetDir}`)

                                // Cleanup conflicting files
                                const tarGzPath = path.join(this.modelsDir, `${modelName}.tar.gz`)
                                if (fs.existsSync(tarGzPath)) {
                                    fs.unlinkSync(tarGzPath)
                                }

                                settled = true
                                resolve({ success: true })
                            } else {
                                // Cleanup failed extraction
                                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
                                settled = true
                                resolve({ success: true })
                            }
                        } catch (e) {
                            console.error(`[Speech] Extraction failed: `, e)
                            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
                            settled = true
                            resolve({ success: false, error: String(e) })
                        }
                    })
                })
            }).on('error', (err) => failDownload(err.message))
            file.on('error', (err) => failDownload(err.message))
        })
    }

    public async cleanup(): Promise<void> {
        await this.server.stop()
    }
}
