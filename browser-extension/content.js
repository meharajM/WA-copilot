const seen = new Set()
const inFlight = new Set()
const MAX_SEEN = 5000

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase()
}

function digits(value) {
  return String(value || '').replace(/\D/g, '')
}

function activeChatLabels() {
  const labels = []
  const title = document.querySelector('[data-testid="conversation-info-header-chat-title"]')
  if (title) labels.push(title.getAttribute('title') || title.textContent || '')
  document.querySelectorAll('header [title]').forEach(node => labels.push(node.getAttribute('title') || ''))
  return labels.map(normalized).filter(Boolean)
}

function activeChatMatches(expected) {
  const wanted = normalized(expected)
  if (!wanted) return false
  const wantedDigits = digits(wanted)
  return activeChatLabels().some(label => label === wanted || (wantedDigits.length >= 8 && digits(label) === wantedDigits))
}

function composer() {
  return document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('[contenteditable="true"][data-tab]')
}

function mediaInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')]
  return inputs.find(input => input && (input.offsetParent !== null || input.getClientRects?.().length)) || inputs[0] || null
}

function mediaSendButton() {
  return document.querySelector('button[data-testid="send"]')
    || document.querySelector('button[aria-label="Send"]')
    || document.querySelector('[data-testid="send"]')
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }

async function sendOutbound(command) {
  if (!command || typeof command.id !== 'string' || typeof command.to !== 'string') return { success: false, error: 'invalid_command' }
  if (!activeChatMatches(command.to)) return { success: false, error: 'active_chat_mismatch' }
  if (command.kind === 'media') return sendMediaOutbound(command)
  if (typeof command.text !== 'string') return { success: false, error: 'invalid_command' }
  const input = composer()
  if (!input) return { success: false, error: 'message_composer_unavailable' }
  input.focus()
  let inserted = false
  try { inserted = document.execCommand('insertText', false, command.text) } catch {}
  if (!inserted) {
    input.textContent = command.text
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.text }))
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
  await wait(250)
  if ((input.innerText || input.textContent || '').trim()) return { success: false, error: 'message_composer_did_not_clear' }
  return { success: true, providerMessageId: `web:${command.id}` }
}

async function sendMediaOutbound(command) {
  const media = command.media
  if (!media || !['image', 'video', 'audio', 'document'].includes(media.type)
    || typeof media.fileName !== 'string' || typeof media.mimeType !== 'string'
    || !Number.isSafeInteger(media.size) || media.size < 1
    || typeof media.dataBase64 !== 'string' || !media.dataBase64
    || media.dataBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(media.dataBase64)) {
    return { success: false, error: 'invalid_media_command' }
  }
  const input = mediaInput()
  if (!input) return { success: false, error: 'media_input_unavailable' }
  let bytes
  try {
    const binary = atob(media.dataBase64)
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  } catch {
    return { success: false, error: 'invalid_media_encoding' }
  }
  if (bytes.length !== media.size) return { success: false, error: 'media_size_mismatch' }
  try {
    const file = new File([bytes], media.fileName, { type: media.mimeType })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  } catch {
    return { success: false, error: 'media_input_rejected' }
  }
  await wait(500)
  if (typeof media.caption === 'string' && media.caption.trim()) {
    const captionInput = composer()
    if (!captionInput) return { success: false, error: 'media_caption_unavailable' }
    captionInput.focus()
    let inserted = false
    try { inserted = document.execCommand('insertText', false, media.caption) } catch {}
    if (!inserted) {
      captionInput.textContent = media.caption
      captionInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: media.caption }))
    }
  }
  const sendButton = mediaSendButton()
  if (!sendButton || typeof sendButton.click !== 'function') return { success: false, error: 'media_send_control_unavailable' }
  sendButton.click()
  await wait(750)
  if (input.files && input.files.length > 0) return { success: false, error: 'media_send_not_acknowledged' }
  return { success: true, providerMessageId: `web:${command.id}` }
}

let outboundPollInFlight = false
function pollOutbound() {
  if (outboundPollInFlight || document.visibilityState !== 'visible') return
  outboundPollInFlight = true
  chrome.runtime.sendMessage({ type: 'poll_outbound' }, response => {
    outboundPollInFlight = false
    const command = response?.command
    if (!command) return
    void sendOutbound(command).then(result => {
      chrome.runtime.sendMessage({ type: 'outbound_result', id: command.id, ...result })
    })
  })
}

function forward(node) {
  const id = node.getAttribute('data-id') || ''
  const content = (node.innerText || '').trim()
  if (!id || !content || seen.has(id) || inFlight.has(id)) return
  inFlight.add(id)
  chrome.runtime.sendMessage({ type: 'inbound_text', id, content: content.slice(0, 100_000) }, response => {
    inFlight.delete(id)
    if (!response || response.accepted !== true || seen.has(id)) return
    seen.add(id)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value)
  })
}

function scan() { document.querySelectorAll('[data-id^="false_"]').forEach(forward) }
scan()
chrome.runtime.sendMessage({ type: 'status', status: 'connected' })
setInterval(scan, 5_000)
setInterval(pollOutbound, 1_000)
pollOutbound()
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
