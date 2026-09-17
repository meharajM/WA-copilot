const token = document.querySelector('#token')
const chatId = document.querySelector('#chatId')
const message = document.querySelector('#message')

chrome.storage.local.get({ token: '', chatId: '' }, settings => {
  token.value = settings.token
  chatId.value = settings.chatId
})

document.querySelector('#save').addEventListener('click', () => {
  const value = { token: token.value.trim(), chatId: chatId.value.trim().slice(0, 256) }
  chrome.storage.local.set(value, () => { message.textContent = ' Saved'; setTimeout(() => { message.textContent = '' }, 1500) })
})
