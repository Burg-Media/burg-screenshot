'use strict'

// Burg Screenshot: service worker
//
// Full page: scroll and stitch. A script in the page (chrome.scripting)
// measures the page, scrolls step by step and hides fixed elements; at each
// step chrome.tabs.captureVisibleTab takes a capture, which is pasted onto an
// OffscreenCanvas here. Afterwards the page is restored exactly.
// Visible area and selection: a single captureVisibleTab.
//
// No global state: everything for one capture lives inside run()/captureFull().

importScripts('lib/i18n.js', 'lib/db.js')

const DEFAULTS = { lazy: true }
const MAX_HEIGHT = 60000 // CSS pixels; beyond this it is probably an infinite scroll
const CANVAS_LIMIT = 32000 // maximum canvas side in Chrome (32767, with margin)
const CANVAS_AREA = 120e6 // max. pixels per part (~480 MB of memory)
const CAPTURE_INTERVAL = 550 // ms; Chrome allows at most 2 captureVisibleTab calls per second

// CSS during a full-page capture: no scrollbars, no smooth scrolling or snapping
const CAPTURE_CSS = `
html, body, [data-burg-capture-target] {
  scrollbar-width: none !important;
  scroll-behavior: auto !important;
  scroll-snap-type: none !important;
}
::-webkit-scrollbar { display: none !important; }
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }
}

// ---------------------------------------------------------------------------
// Progress (badge + message to the popup if it is still open)
// ---------------------------------------------------------------------------

function progress(tabId, text, percent) {
  chrome.action.setBadgeBackgroundColor({ color: '#2E6BFF', tabId })
  chrome.action.setBadgeTextColor({ color: '#0E0E10', tabId })
  chrome.action.setBadgeText({ text: percent !== undefined ? `${percent}%` : '…', tabId })
  chrome.runtime.sendMessage({ type: 'progress', text, percent }).catch(() => {})
}

function done(tabId, error) {
  if (error) {
    chrome.action.setBadgeBackgroundColor({ color: '#F2678C', tabId })
    chrome.action.setBadgeTextColor({ color: '#0E0E10', tabId })
    chrome.action.setBadgeText({ text: '!', tabId })
    chrome.action.setTitle({ title: `${t('extName')}: ${error}`, tabId })
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '', tabId }).catch(() => {})
      chrome.action.setTitle({ title: t('extName'), tabId }).catch(() => {})
    }, 6000)
  } else {
    chrome.action.setBadgeText({ text: '', tabId })
  }
}

function assertCapturable(tab) {
  if (!tab.url || !/^(https?|file):/.test(tab.url) || /^https:\/\/chromewebstore\.google\.com/.test(tab.url)) {
    throw new Error(t('errNotCapturable'))
  }
}

/** Turns technical Chrome errors into understandable messages. */
function friendlyError(tab, error) {
  const message = error && error.message ? error.message : String(error)
  if (/^file:/.test(tab.url || '') && /permission|cannot access|file/i.test(message)) {
    return t('errFileAccess')
  }
  if (/cannot access|permission|activeTab/i.test(message)) {
    return t('errNoAccess')
  }
  if (/No tab with id|tab was closed|Frame with ID 0 was removed/i.test(message)) {
    return t('errTabClosed')
  }
  return message
}

// ---------------------------------------------------------------------------
// Capture of the visible area (respecting Chrome's rate limit)
// ---------------------------------------------------------------------------

async function grab(windowId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      return await createImageBitmap(await (await fetch(dataUrl)).blob())
    } catch (error) {
      if (attempt < 5 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(error.message)) {
        await sleep(CAPTURE_INTERVAL + 100)
        continue
      }
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Full page: script in the page
// ---------------------------------------------------------------------------

/**
 * Runs in the page (isolated world, so separate from the page's own scripts).
 * Finds out what scrolls (the window or an inner container), optionally
 * scrolls through for lazy loading, moves sticky elements back to their normal
 * place, and puts step() and restore() on window.__burgCapture for the
 * following calls. Everything that is changed is saved first.
 */
async function pagePrepare(lazy) {
  if (window.__burgCapture) window.__burgCapture.restore() // leftover from an aborted capture

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // Wait two frames so the page has really painted (with a timeout: rAF can stall)
  const frames = () =>
    Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(300)])

  const doc = document.scrollingElement || document.documentElement
  const vw = innerWidth
  const vh = innerHeight
  const start = { x: scrollX, y: scrollY }

  // 1. What scrolls: the window, or (on app-like pages) a div?
  let windowScrolls = scrollY > 0
  if (!windowScrolls && doc.scrollHeight > vh + 4) {
    window.scrollTo({ top: 1, left: scrollX, behavior: 'instant' })
    windowScrolls = scrollY > 0
    window.scrollTo({ top: start.y, left: start.x, behavior: 'instant' })
  }
  // Also when the window scrolls only a few pixels: then the content is often in a div
  let target = null
  if (!windowScrolls || doc.scrollHeight - vh < 100) {
    let best = 0
    for (const el of document.querySelectorAll('body, body *')) {
      if (el.clientHeight < 100 || el.scrollHeight <= el.clientHeight + 20) continue
      if (!/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) continue
      const r = el.getBoundingClientRect()
      const area =
        Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
      if (area > best) {
        best = area
        target = el
      }
    }
    // Too small to be "the page": then only the visible area
    if (best < vw * vh * 0.2) target = null
  }
  const targetStart = target ? { x: target.scrollLeft, y: target.scrollTop } : null
  if (target) target.setAttribute('data-burg-capture-target', '')

  const position = () => (target ? target.scrollTop : scrollY)
  const maxScroll = () => (target ? target.scrollHeight - target.clientHeight : doc.scrollHeight - innerHeight)
  const scrollToY = (y) => {
    if (target) target.scrollTo({ top: y, left: target.scrollLeft, behavior: 'instant' })
    else window.scrollTo({ top: y, left: 0, behavior: 'instant' })
  }

  // Save inline styles and restore them exactly (incl. !important)
  const saveStyle = (el, props) =>
    props.map((prop) => [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)])
  const restoreStyle = (el, saved) => {
    for (const [prop, value, priority] of saved) {
      if (value) el.style.setProperty(prop, value, priority)
      else el.style.removeProperty(prop)
    }
  }
  const sticky = [] // [el, saved style]
  const hidden = [] // [el, saved style]
  const hiddenSet = new WeakSet()

  window.__burgCapture = {
    /** Scrolls to y, hides fixed elements (after the first capture) and returns the actual position. */
    async step(y, hideFixed) {
      scrollToY(y)
      if (hideFixed) {
        for (const el of document.querySelectorAll('body *')) {
          if (hiddenSet.has(el)) continue
          const s = getComputedStyle(el)
          if (s.position !== 'fixed' || s.display === 'none' || s.visibility === 'hidden') continue
          if (target && (el === target || el.contains(target))) continue
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          // Full screen = background or app shell: that belongs on every capture
          if (r.width >= vw * 0.9 && r.height >= vh * 0.9) continue
          hiddenSet.add(el)
          hidden.push([el, saveStyle(el, ['visibility', 'opacity', 'transition'])])
          el.style.setProperty('transition', 'none', 'important')
          el.style.setProperty('visibility', 'hidden', 'important')
          el.style.setProperty('opacity', '0', 'important')
        }
      }
      await frames()
      await sleep(60)
      return position()
    },

    /** Puts everything back the way it was. */
    restore() {
      for (const [el, saved] of hidden) {
        // Restore visibility first, then the transition (otherwise it fades in)
        restoreStyle(el, saved.filter(([prop]) => prop !== 'transition'))
        void getComputedStyle(el).opacity
        restoreStyle(el, saved.filter(([prop]) => prop === 'transition'))
      }
      for (const [el, saved] of sticky) restoreStyle(el, saved)
      if (target) {
        target.removeAttribute('data-burg-capture-target')
        target.scrollTo({ top: targetStart.y, left: targetStart.x, behavior: 'instant' })
      }
      window.scrollTo({ top: start.y, left: start.x, behavior: 'instant' })
      delete window.__burgCapture
    },
  }

  // 2. Scroll through first so lazy-loaded images load (max ~8 s)
  if (lazy && maxScroll() > 0) {
    const began = performance.now()
    const stepSize = Math.max(200, (target ? target.clientHeight : innerHeight) * 0.8)
    for (let y = 0; y < maxScroll() && performance.now() - began < 8000; y += stepSize) {
      scrollToY(y)
      await sleep(120)
    }
    scrollToY(maxScroll())
    await sleep(300)
    scrollToY(0)
    // Wait for images that are still loading (max 3 s)
    const pending = [...document.images].filter((img) => !img.complete)
    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true })
              img.addEventListener('error', resolve, { once: true })
            })
        )
      ),
      sleep(3000),
    ])
  }

  // 3. Put sticky elements in their normal place: that way they appear exactly once
  for (const el of document.querySelectorAll('body *')) {
    if (getComputedStyle(el).position !== 'sticky') continue
    sticky.push([el, saveStyle(el, ['position', 'top', 'bottom', 'left', 'right'])])
    el.style.setProperty('position', 'relative', 'important')
    for (const prop of ['top', 'bottom', 'left', 'right']) el.style.setProperty(prop, 'auto', 'important')
  }

  // 4. Start at the top and measure
  scrollToY(0)
  await frames()
  await sleep(150)

  let region = { x: 0, y: 0, w: innerWidth, h: innerHeight }
  if (target) {
    const r = target.getBoundingClientRect()
    const left = r.left + target.clientLeft
    const top = r.top + target.clientTop
    const x = Math.max(0, left)
    const y = Math.max(0, top)
    region = {
      x,
      y,
      w: Math.max(1, Math.min(innerWidth, left + target.clientWidth) - x),
      h: Math.max(1, Math.min(innerHeight, top + target.clientHeight) - y),
    }
  }

  return {
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    region, // the part of the window that scrolls (for the window itself: everything)
    maxScroll: Math.max(0, Math.floor(maxScroll())),
    position: position(),
    inner: !!target,
  }
}

// errorText is passed in translated: this function runs in the page, without t()
async function pageStep(y, hideFixed, errorText) {
  if (!window.__burgCapture) throw new Error(errorText)
  return window.__burgCapture.step(y, hideFixed)
}

function pageRestore() {
  if (window.__burgCapture) window.__burgCapture.restore()
}

// ---------------------------------------------------------------------------
// Full page: capture and stitch
// ---------------------------------------------------------------------------

/**
 * Captures the whole page. Each part (canvas) is saved via onPart as soon as it
 * is complete, so all parts are never in memory at the same time.
 */
async function captureFull(tab, settings, onPart) {
  const target = { tabId: tab.id }
  const inject = async (func, args = []) => {
    const [injection] = await chrome.scripting.executeScript({ target, func, args })
    return injection ? injection.result : undefined
  }

  let lastShot = 0
  const shoot = async () => {
    const wait = lastShot + CAPTURE_INTERVAL - Date.now()
    if (wait > 0) await sleep(wait)
    const current = await chrome.tabs.get(tab.id)
    if (!current.active) throw new Error(t('errSwitchedTab'))
    const bitmap = await grab(current.windowId)
    lastShot = Date.now()
    return bitmap
  }

  let cssInserted = false
  try {
    progress(tab.id, settings.lazy ? t('progressLazy') : t('progressPrepare'))
    await chrome.scripting.insertCSS({ target, css: CAPTURE_CSS })
    cssInserted = true
    const page = await inject(pagePrepare, [!!settings.lazy])
    if (!page) throw new Error(t('errPrepare'))

    const { region, viewportWidth, viewportHeight } = page
    let maxScroll = page.maxScroll
    const truncated = viewportHeight + maxScroll > MAX_HEIGHT
    if (truncated) maxScroll = Math.max(0, MAX_HEIGHT - viewportHeight)
    const regionBottom = region.y + region.h
    const totalTiles = 1 + Math.ceil(maxScroll / region.h)

    // First capture: fixed headers are still shown normally here
    progress(tab.id, t('progressCapture'), 0)
    const first = await shoot()
    const ratio = first.width / viewportWidth // device pixels per CSS pixel (retina, zoom)
    const px = (v) => Math.round(v * ratio)
    const widthPx = first.width
    const totalPx = px(viewportHeight + maxScroll)

    // Split into canvases that Chrome can handle
    const partHeight = Math.max(1, Math.floor(Math.min(CANVAS_LIMIT, CANVAS_AREA / widthPx)))
    const count = Math.max(1, Math.ceil(totalPx / partHeight))
    const parts = Array.from({ length: count }, (_, i) => ({
      start: i * partHeight,
      end: Math.min(totalPx, (i + 1) * partHeight),
      canvas: null,
      saved: false,
    }))
    const canvasFor = (part) => {
      if (!part.canvas) {
        part.canvas = new OffscreenCanvas(widthPx, part.end - part.start)
        const ctx = part.canvas.getContext('2d')
        ctx.fillStyle = '#fff' // empty areas (next to an inner container) white
        ctx.fillRect(0, 0, part.canvas.width, part.canvas.height)
      }
      return part.canvas.getContext('2d')
    }

    /** Pastes a piece of the capture (CSS coordinates in the window) at height dy in the result. */
    const paste = (bitmap, sx, sy, sw, sh, dy) => {
      const x = Math.min(px(sx), bitmap.width)
      const y = Math.min(px(sy), bitmap.height)
      const w = Math.min(px(sx + sw), bitmap.width) - x
      const h = Math.min(px(sy + sh), bitmap.height) - y
      // Target height from the same rounding as the next step: no 1-pixel seams
      const top = px(dy)
      const height = px(dy + sh) - top
      if (w <= 0 || h <= 0 || height <= 0) return
      for (const part of parts) {
        if (part.saved || part.end <= top || part.start >= top + height) continue
        canvasFor(part).drawImage(bitmap, x, y, w, h, x, top - part.start, w, height)
      }
    }

    /** Saves all parts that are filled up to `upTo` (device pixels). */
    const flush = async (upTo) => {
      for (const [index, part] of parts.entries()) {
        if (part.saved) continue
        if (part.end > upTo) break
        canvasFor(part)
        await onPart(part.canvas, index, count, truncated)
        part.canvas = null
        part.saved = true
      }
    }

    // First capture: everything above the bottom of the scroll area; whatever is below
    // it (e.g. a fixed bar under an inner container) goes at the very bottom.
    paste(first, 0, 0, viewportWidth, regionBottom, page.position)
    if (regionBottom < viewportHeight) {
      paste(first, 0, regionBottom, viewportWidth, viewportHeight - regionBottom, regionBottom + maxScroll)
    }
    first.close()
    await flush(px(regionBottom))

    // Next steps: only the scrolling part, fixed elements hidden
    for (let k = 1, y = 0; y < maxScroll; k++) {
      y = Math.min(k * region.h, maxScroll)
      progress(tab.id, t('progressCapture'), Math.min(99, Math.round((k / totalTiles) * 100)))
      const actual = await inject(pageStep, [y, true, t('errReloaded')])
      if (!Number.isFinite(actual)) throw new Error(t('errReloadedOrLeft'))
      const bitmap = await shoot()
      paste(bitmap, region.x, region.y, region.w, region.h, region.y + actual)
      bitmap.close()
      await flush(px(region.y + actual + region.h))
      if (actual + 1 < y) break // page got shorter; cannot scroll further
    }

    await flush(Infinity)
  } finally {
    // Always restore the page, also after an error (the tab may have been closed meanwhile)
    if (cssInserted) await chrome.scripting.removeCSS({ target, css: CAPTURE_CSS }).catch(() => {})
    await inject(pageRestore).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Visible area and selection
// ---------------------------------------------------------------------------

async function captureVisible(tab, rect) {
  const bitmap = await grab(tab.windowId)
  let canvas
  if (!rect) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
  } else {
    const ratio = bitmap.width / rect.viewportWidth
    const sx = Math.round(rect.x * ratio)
    const sy = Math.round(rect.y * ratio)
    const sw = Math.max(1, Math.round(rect.width * ratio))
    const sh = Math.max(1, Math.round(rect.height * ratio))
    canvas = new OffscreenCanvas(sw, sh)
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  }
  bitmap.close()
  return canvas
}

// ---------------------------------------------------------------------------
// Save and show
// ---------------------------------------------------------------------------

async function makeThumb(canvas) {
  // Top of the image, 320 px wide
  const width = Math.min(320, canvas.width)
  const height = Math.min(Math.round((canvas.height * width) / canvas.width), 400)
  const thumb = new OffscreenCanvas(width, height)
  thumb.getContext('2d').drawImage(canvas, 0, 0, canvas.width, (height * canvas.width) / width, 0, 0, width, height)
  return thumb.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
}

async function savePart(shot, canvas, index, count, truncated) {
  const id = count > 1 ? `${shot.group}-${index + 1}` : shot.group
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  await ShotDB.save(
    {
      id,
      group: shot.group,
      part: index + 1,
      parts: count,
      mode: shot.mode,
      url: shot.url,
      title: shot.title,
      createdAt: shot.createdAt,
      width: canvas.width,
      height: canvas.height,
      truncated: !!truncated,
      thumb: await makeThumb(canvas),
    },
    blob
  )
  return id
}

async function run(tab, mode, rect) {
  const createdAt = Date.now()
  const shot = {
    group: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    mode,
    url: tab.url,
    title: tab.title,
  }
  const ids = []
  const onPart = async (canvas, index, count, truncated) => {
    if (mode === 'full') progress(tab.id, count > 1 ? t('progressSavePart', index + 1, count) : t('progressSave'))
    ids.push(await savePart(shot, canvas, index, count, truncated))
  }

  try {
    assertCapturable(tab)
    if (mode === 'full') {
      await captureFull(tab, await getSettings(), onPart)
    } else {
      await onPart(await captureVisible(tab, rect), 0, 1, false)
    }
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`viewer/viewer.html?id=${ids[0]}`),
      index: tab.index + 1,
      openerTabId: tab.id,
    })
    done(tab.id)
    return { ok: true }
  } catch (error) {
    console.error('[Burg Screenshot]', error)
    // Don't leave half-saved parts behind
    for (const id of ids) await ShotDB.remove(id).catch(() => {})
    const message = friendlyError(tab, error)
    done(tab.id, message)
    return { ok: false, error: message }
  }
}

async function startSelection(tab) {
  try {
    assertCapturable(tab)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/i18n.js', 'content/select.js'] })
    return { ok: true }
  } catch (error) {
    const message = friendlyError(tab, error)
    done(tab.id, message)
    return { ok: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Messages, keyboard shortcuts and installation
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return
  if (message.type === 'capture') {
    ;(async () => {
      const tab = await chrome.tabs.get(message.tabId)
      sendResponse(await (message.mode === 'selection' ? startSelection(tab) : run(tab, message.mode)))
    })()
    return true
  }
  if (message.type === 'selection-done' && sender.tab) {
    ;(async () => sendResponse(await run(sender.tab, 'selection', message.rect)))()
    return true
  }
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return
  if (command === 'capture-full') run(tab, 'full')
  if (command === 'capture-selection') startSelection(tab)
})

// Settings from version 1.0.0 that no longer exist (width and sharpness via the debugger)
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['width', 'scale', 'format']).catch(() => {})
})

// Burg Media: welcome page after installing, short page after uninstalling.
// Only UTM tags in the URL; nothing else is sent.
const SITE = 'https://burgmedia.eu/extensies/burg-screenshot/'
const utm = (campaign) => '?utm_source=burg-screenshot&utm_medium=extension&utm_campaign=' + campaign
chrome.runtime.setUninstallURL(SITE + 'verwijderd/' + utm('uninstall'))
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: SITE + 'welkom/' + utm('install') })
})
