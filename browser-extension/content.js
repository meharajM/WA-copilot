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

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }

async function sendOutbound(command) {
  if (!command || typeof command.id !== 'string' || typeof command.to !== 'string' || typeof command.text !== 'string') return { success: false, error: 'invalid_command' }
  if (!activeChatMatches(command.to)) return { success: false, error: 'active_chat_mismatch' }
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
