const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_SPEECH_MODEL_BYTES = 200 * 1024 * 1024
const MAX_REDIRECTS = 3
const MODEL_HOST = 'alphacephei.com'

const SPEECH_MODELS = Object.freeze({
  'en-us': Object.freeze({
    id: 'en-us',
    name: 'English (US)',
    modelName: 'vosk-model-small-en-us-0.15',
    locale: 'en-US',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
    sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
  }),
})

function modelFor(modelId, catalog = SPEECH_MODELS) {
  return typeof modelId === 'string' ? catalog[modelId] : undefined
}

function safeModelId(modelId) {
  return typeof modelId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(modelId)
}

function approvedUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname === MODEL_HOST && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

function modelPath(dataDir, model) {
  return path.join(dataDir, `${model.id}.zip`)
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filename))
  return hash.digest('hex')
}

async function writeResponseAtomically(filename, response, expectedDigest) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > MAX_SPEECH_MODEL_BYTES) throw Object.assign(new Error('Speech model exceeds size limit'), { statusCode: 413 })

  let handle
  let reader
  let total = 0
  const hash = crypto.createHash('sha256')
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600)
    const writeChunk = async chunkValue => {
      const chunk = Buffer.from(chunkValue)
      total += chunk.length
      if (total > MAX_SPEECH_MODEL_BYTES) throw Object.assign(new Error('Speech model exceeds size limit'), { statusCode: 413 })
      hash.update(chunk)
      await handle.writeFile(chunk)
    }
    if (response.body?.getReader) {
      reader = response.body.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        await writeChunk(next.value)
      }
    } else {
      await writeChunk(await response.arrayBuffer())
    }
    reader?.releaseLock?.()
    reader = null
    await handle.sync()
    await handle.close()
    handle = null
    fs.chmodSync(temporary, 0o600)
    if (hash.digest('hex') !== expectedDigest.toLowerCase()) throw Object.assign(new Error('Speech model integrity check failed'), { statusCode: 503 })
    fs.renameSync(temporary, filename)
    return { size: total }
  } catch (error) {
    reader?.releaseLock?.()
    try { await handle?.close() } catch {}
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

class SpeechModelStore {
  constructor(dataDir, { fetchImpl = globalThis.fetch, catalog = SPEECH_MODELS } = {}) {
    this.modelsDir = path.join(dataDir, 'speech-models')
    this.fetchImpl = fetchImpl
    this.catalog = catalog
    this.downloads = new Map()
  }

  model(modelId) {
    const model = safeModelId(modelId) ? modelFor(modelId, this.catalog) : undefined
    if (!model || !approvedUrl(model.url) || !/^[a-f0-9]{64}$/i.test(model.sha256 || '')) return null
    return model
  }

  modelPath(model) {
    return modelPath(this.modelsDir, model)
  }

  status(modelId) {
    const model = this.model(modelId)
    if (!model) return { modelId, supported: false, modelDownloaded: false }
    const filename = this.modelPath(model)
    let modelDownloaded = false
    try {
      const stat = fs.lstatSync(filename)
      modelDownloaded = stat.isFile() && stat.size > 0 && stat.size <= MAX_SPEECH_MODEL_BYTES && sha256File(filename) === model.sha256.toLowerCase()
    } catch {}
    return { modelId: model.id, supported: true, modelDownloaded, locale: model.locale, name: model.name }
  }

  async ensure(modelId) {
    const model = this.model(modelId)
    if (!model) throw Object.assign(new Error('Speech model is not approved'), { statusCode: 404 })
    const existing = this.downloads.get(model.id)
    if (existing) return existing
    const pending = this.ensureModel(model)
    this.downloads.set(model.id, pending)
    try { return await pending } finally { if (this.downloads.get(model.id) === pending) this.downloads.delete(model.id) }
  }

  async ensureModel(model) {
    fs.mkdirSync(this.modelsDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.modelsDir, 0o700)
    const filename = this.modelPath(model)
    try {
      const stat = fs.lstatSync(filename)
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_SPEECH_MODEL_BYTES && sha256File(filename) === model.sha256.toLowerCase()) {
        return { ...model, path: filename, size: stat.size }
      }
      fs.unlinkSync(filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    let response
    let url = model.url
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      response = await this.fetchImpl(url, { redirect: 'manual' })
      if (response.status >= 300 && response.status < 400 && response.headers?.get?.('location')) {
        if (redirect === MAX_REDIRECTS) throw Object.assign(new Error('Speech model redirect limit exceeded'), { statusCode: 502 })
        const next = new URL(response.headers.get('location'), url)
        if (!approvedUrl(next.toString())) throw Object.assign(new Error('Speech model URL is not approved'), { statusCode: 502 })
        url = next.toString()
        continue
      }
      break
    }
    if (!response?.ok) throw Object.assign(new Error('Speech model download failed'), { statusCode: 503 })
    const written = await writeResponseAtomically(filename, response, model.sha256)
    return { ...model, path: filename, size: written.size }
  }
}

module.exports = { MAX_SPEECH_MODEL_BYTES, SPEECH_MODELS, SpeechModelStore, safeModelId, approvedUrl }
