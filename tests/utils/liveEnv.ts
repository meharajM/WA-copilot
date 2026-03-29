import fs from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

let loaded = false

function loadEnvFiles(): void {
  if (loaded) return

  const candidates = ['.env.test.local', '.env.test', '.env']
  for (const file of candidates) {
    const fullPath = path.resolve(process.cwd(), file)
    if (fs.existsSync(fullPath)) {
      loadDotenv({ path: fullPath, override: false })
    }
  }

  loaded = true
}

function readFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export interface OpenRouterLiveConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export function isLiveLLMEnabled(): boolean {
  loadEnvFiles()
  return readFlag('LIVE_LLM_TESTS')
}

export function getOpenRouterLiveConfig(
  strict = false
): OpenRouterLiveConfig | null {
  loadEnvFiles()

  const rawApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? ''
  const model = process.env.OPENROUTER_MODEL?.trim() ?? ''
  const apiKey =
    rawApiKey &&
    !rawApiKey.toLowerCase().includes('replace_with') &&
    !rawApiKey.toLowerCase().includes('your_')
      ? rawApiKey
      : ''
  const baseUrl =
    process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1'

  if (apiKey && model) {
    return { apiKey, model, baseUrl }
  }

  if (strict) {
    const missing: string[] = []
    if (!apiKey) missing.push('OPENROUTER_API_KEY')
    if (!model) missing.push('OPENROUTER_MODEL')
    throw new Error(
      `Missing required live test env vars: ${missing.join(', ')}`
    )
  }

  return null
}

export function expectNativeTools(): boolean {
  loadEnvFiles()
  const value = process.env.LIVE_EXPECT_NATIVE_TOOLS?.trim().toLowerCase()
  if (!value) return true
  return value !== '0' && value !== 'false' && value !== 'no'
}
