function bridgeUrl(path) { return `http://127.0.0.1:8790${path}` }

async function post(path, body, settings) {
  if (!settings.token) return
  await fetch(bridgeUrl(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {})
}

async function pollOutbound(settings) {
  if (!settings.token || !settings.chatId) return { command: null }
  try {
    const response = await fetch(bridgeUrl(`/outbound?chatId=${encodeURIComponent(settings.chatId)}`), {
      headers: { Authorization: `Bearer ${settings.token}` },
    })
    if (!response.ok) return { command: null }
    const body = await response.json()
    return body && body.command && typeof body.command.id === 'string' ? { command: body.command } : { command: null }
  } catch {
    return { command: null }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type === 'status') {
    if (message?.type === 'status' && typeof message.status === 'string') chrome.storage.local.get({ token: '' }, settings => void post('/status', { status: message.status.slice(0, 64) }, settings))
    return
  }
  if (message.type === 'poll_outbound') {
    chrome.storage.local.get({ token: '', chatId: '' }, async settings => sendResponse(await pollOutbound(settings)))
    return true
  }
  if (message.type === 'outbound_result' && typeof message.id === 'string' && typeof message.success === 'boolean') {
    chrome.storage.local.get({ token: '' }, settings => void post('/outbound/result', {
      id: message.id.slice(0, 128),
      success: message.success,
      ...(typeof message.providerMessageId === 'string' ? { providerMessageId: message.providerMessageId.slice(0, 300) } : {}),
      ...(typeof message.error === 'string' ? { error: message.error.slice(0, 256) } : {}),
    }, settings))
    return
  }
  if (message.type !== 'inbound_text' || typeof message.id !== 'string' || typeof message.content !== 'string') return
  chrome.storage.local.get({ token: '', chatId: '' }, settings => {
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
