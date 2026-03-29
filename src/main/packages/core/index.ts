/**
 * @copilot/core
 * 
 * Foundational utilities for the WA Co-Pilot intelligence suite.
 * Includes: Gemini API client, Multimodal helpers, and Common Types.
 */

export interface GeminiResponse {
    text: string
    usage?: { promptTokens: number; completionTokens: number }
}

export class GeminiClient {
    private apiKey: string

    constructor(apiKey: string) {
        this.apiKey = apiKey
    }

    /**
     * General text-based generation (used for profile extraction, summaries, etc.)
     */
    async generateText(prompt: string, context?: string): Promise<string> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`
        
        const body = {
            contents: [{
                parts: [
                    { text: context ? `Context: ${context}\n\nTask: ${prompt}` : prompt }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                topP: 0.95,
                maxOutputTokens: 2048,
            }
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const err = await response.text()
            throw new Error(`Gemini API error: ${response.status} - ${err}`)
        }

        const data = await response.json()
        return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }

    /**
     * Multimodal generation (OCR / Image transcription)
     */
    async transcribeImage(imagePath: string, prompt: string = 'Transcribe all relevant business information, pricing, and policies from this image into clean Markdown.'): Promise<string> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`
        
        // Read file and convert to base64
        const fs = await import('fs')
        const buffer = fs.readFileSync(imagePath)
        const base64 = buffer.toString('base64')
        const mimeType = this._getMimeType(imagePath)

        const body = {
            contents: [{
                parts: [
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType,
                            data: base64
                        }
                    }
                ]
            }]
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })

        if (!response.ok) {
            const err = await response.text()
            throw new Error(`Gemini Vision error: ${response.status} - ${err}`)
        }

        const data = await response.json()
        return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }

    private _getMimeType(filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase()
        switch (ext) {
            case 'png': return 'image/png'
            case 'webp': return 'image/webp'
            case 'heic': return 'image/heic'
            case 'heif': return 'image/heif'
            default: return 'image/jpeg'
        }
    }
}
