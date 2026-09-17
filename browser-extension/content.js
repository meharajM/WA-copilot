const seen = new Set()
const inFlight = new Set()
const MAX_SEEN = 5000

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
new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
