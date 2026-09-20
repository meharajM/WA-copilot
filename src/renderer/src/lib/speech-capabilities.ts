/**
 * Browser speech capability helpers.
 *
 * Electron keeps using the local Vosk path. Browser product UI can use the
 * Web Speech API when the host browser exposes it; unsupported browsers must
 * remain text-only instead of trying to access microphone APIs directly.
 */

export type BrowserSpeechRecognitionConstructor = new () => SpeechRecognition

type SpeechRecognitionWindow = {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
}

export function getBrowserSpeechRecognitionConstructor(
  target: SpeechRecognitionWindow | undefined = typeof window === 'undefined' ? undefined : window,
): BrowserSpeechRecognitionConstructor | null {
  return target?.SpeechRecognition || target?.webkitSpeechRecognition || null
}

export function browserSpeechRecognitionSupported(
  target: SpeechRecognitionWindow | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  return getBrowserSpeechRecognitionConstructor(target) !== null
}

export function browserSpeechErrorMessage(error: unknown, language: string): string {
  const code = typeof error === 'string'
    ? error
    : typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string'
      ? error.error
      : ''

  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone or browser speech access is blocked. Allow microphone access for this site, then try again.'
    case 'audio-capture':
      return 'No microphone was found. Connect a microphone and try again.'
    case 'language-not-supported':
      return `Browser speech does not support ${language || 'this language'}. Choose another speech language.`
    case 'network':
      return 'Browser speech service is unavailable. Check your connection or use text input.'
    case 'phrases-not-supported':
      return 'Browser speech phrases are unavailable. Try again or use text input.'
    default:
      return code ? `Browser speech error: ${code}` : 'Browser speech recognition failed. Use text input.'
  }
}

export function browserSpeechShouldRestart(error: unknown): boolean {
  const code = typeof error === 'string'
    ? error
    : typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string'
      ? error.error
      : ''

  // Restart only normal continuous-recognition endings. Unknown failures must
  // stop so a browser/service error cannot create an unbounded retry loop.
  return code === '' || code === 'no-speech' || code === 'aborted'
}
