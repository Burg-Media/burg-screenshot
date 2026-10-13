'use strict'

const DEFAULTS = { lazy: true }
const $ = (id) => document.getElementById(id)

localizePage()

// Load and save the setting
chrome.storage.local.get(Object.keys(DEFAULTS)).then((stored) => {
  $('lazy').checked = { ...DEFAULTS, ...stored }.lazy
})
$('lazy').addEventListener('change', () => chrome.storage.local.set({ lazy: $('lazy').checked }))

// chrome:// links don't open from a regular <a>
$('shortcuts').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
})

function setStatus(text, percent, error = false) {
  $('status').hidden = false
  $('status').classList.toggle('error', error)
  $('status-text').textContent = text
  $('bar-fill').style.width = `${percent ?? 0}%`
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'progress') setStatus(message.text, message.percent)
})

for (const button of document.querySelectorAll('.action')) {
  button.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const mode = button.dataset.mode
    for (const b of document.querySelectorAll('.action')) b.disabled = true

    if (mode === 'visible') {
      // The result opens in a new tab; the popup is no longer needed
      chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id })
      setTimeout(() => window.close(), 50)
      return
    }

    setStatus(mode === 'selection' ? t('statusSelection') : t('statusStart'), 0)
    const response = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id })
    if (response && response.ok) {
      if (mode === 'selection') window.close()
      return
    }
    setStatus(response ? response.error : t('errUnknown'), 100, true)
    for (const b of document.querySelectorAll('.action')) b.disabled = false
  })
}
