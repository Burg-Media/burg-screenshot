'use strict'

// Burg Screenshot: translations via chrome.i18n (_locales/en, _locales/nl).
// Shared by the service worker, popup, viewer and the selection overlay.
//
//   t('copied', '#FF0000')  fills {0}, {1} … in the message
//   localizePage()          fills elements marked with data-i18n (text) and
//                           data-i18n-title / -aria-label / -placeholder

self.t ??= (key, ...args) =>
  (chrome.i18n.getMessage(key) || key).replace(/\{(\d)\}/g, (_, i) => String(args[i] ?? ''))

self.localizePage ??= () => {
  document.documentElement.lang = t('lang')
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)))
    }
  }
}
