function bridgeUrl(path) { return `http://127.0.0.1:8790${path}` }

async function post(path, body, settings) {
  if (!settings.token) return
  await fetch(bridgeUrl(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {})
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type === 'status') {
    if (message?.type === 'status' && typeof message.status === 'string') chrome.storage.local.get({ token: '' }, settings => void post('/status', { status: message.status.slice(0, 64) }, settings))
    return
  }
  if (message.type !== 'inbound_text' || typeof message.id !== 'string' || typeof message.content !== 'string') return
  chrome.storage.local.get({ token: '', chatId: '', port: '8790' }, settings => {
    if (!settings.chatId) { sendResponse({ accepted: false }); return }
    fetch(bridgeUrl('/messages'), { method: 'POST', headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { id: message.id.slice(0, 256), from: settings.chatId, content: message.content.slice(0, 100_000), timestamp: Date.now(), to: '' } }) })
      .then(response => response.json().then(body => ({ accepted: response.status === 202 && body.accepted === true })))
      .catch(() => ({ accepted: false }))
      .then(result => sendResponse(result))
  })
  return true
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ token: '' }, settings => void post('/status', { status: 'installed' }, settings))
})
