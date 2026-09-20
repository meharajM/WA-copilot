import { describe, expect, it } from 'vitest'
import {
  browserSpeechErrorMessage,
  browserSpeechRecognitionSupported,
  browserSpeechShouldRestart,
  getBrowserSpeechRecognitionConstructor,
} from '../../src/renderer/src/lib/speech-capabilities'

describe('browser speech capabilities', () => {
  it('prefers the standard constructor and supports Chromium webkit fallback', () => {
    class StandardRecognition {}
    class WebkitRecognition {}

    expect(getBrowserSpeechRecognitionConstructor({
      SpeechRecognition: StandardRecognition as never,
      webkitSpeechRecognition: WebkitRecognition as never,
    })).toBe(StandardRecognition)
    expect(getBrowserSpeechRecognitionConstructor({ webkitSpeechRecognition: WebkitRecognition as never })).toBe(WebkitRecognition)
    expect(browserSpeechRecognitionSupported({})).toBe(false)
  })

  it('maps permission and device failures to actionable browser-safe copy', () => {
    expect(browserSpeechErrorMessage({ error: 'not-allowed' }, 'en-US')).toContain('Allow microphone access')
    expect(browserSpeechErrorMessage({ error: 'audio-capture' }, 'en-US')).toContain('No microphone')
    expect(browserSpeechErrorMessage({ error: 'language-not-supported' }, 'hi-IN')).toContain('hi-IN')
    expect(browserSpeechErrorMessage({ error: 'network' }, 'en-US')).toContain('speech service')
  })

  it('only retries transient browser recognition endings', () => {
    expect(browserSpeechShouldRestart('no-speech')).toBe(true)
    expect(browserSpeechShouldRestart('aborted')).toBe(true)
    expect(browserSpeechShouldRestart({ error: 'network' })).toBe(false)
    expect(browserSpeechShouldRestart({ error: 'unknown' })).toBe(false)
    expect(browserSpeechShouldRestart({ error: 'not-allowed' })).toBe(false)
    expect(browserSpeechShouldRestart({ error: 'audio-capture' })).toBe(false)
    expect(browserSpeechShouldRestart({ error: 'language-not-supported' })).toBe(false)
  })
})
