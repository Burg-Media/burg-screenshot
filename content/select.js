'use strict'

// Selection overlay: drag a rectangle, Esc cancels.
// Injected each time via chrome.scripting.executeScript (after lib/i18n.js).
;(() => {
  if (window.__burgSelecting) return
  window.__burgSelecting = true

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(14, 14, 16, 0.4); }
      .box { position: fixed; border: 2px solid #2E6BFF; background: transparent; box-sizing: border-box;
             box-shadow: 0 0 0 9999px rgba(14, 14, 16, 0.4); display: none; }
      .layer.active { background: transparent; }
      .hint, .size { position: fixed; box-sizing: border-box; margin: 0; pointer-events: none;
                     font: 500 13px/1.4 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
                     letter-spacing: normal; text-transform: none; -webkit-font-smoothing: antialiased; }
      .hint { top: 14px; left: 50%; transform: translateX(-50%); color: #F4F3F0; background: #0E0E10;
              border: 1px solid #2A2A30; border-top: 3px solid #2E6BFF; border-radius: 10px; padding: 7px 14px;
              box-shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.18); white-space: nowrap; }
      .size { display: none; color: #0E0E10; background: #2E6BFF; border-radius: 999px; padding: 2px 8px;
              font: 600 11px/1.4 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
              font-variant-numeric: tabular-nums; }
    </style>
    <div class="layer"></div>
    <div class="box"></div>
    <div class="hint"></div>
    <div class="size"></div>`
  document.documentElement.appendChild(host)

  const layer = root.querySelector('.layer')
  const box = root.querySelector('.box')
  const size = root.querySelector('.size')
  const hint = root.querySelector('.hint')
  hint.textContent = t('selectHint')
  let start = null
  let rect = null

  const cleanup = () => {
    host.remove()
    window.removeEventListener('keydown', onKey, true)
    delete window.__burgSelecting
  }

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cleanup()
    }
  }
  window.addEventListener('keydown', onKey, true)

  layer.addEventListener('mousedown', (event) => {
    event.preventDefault()
    start = { x: event.clientX, y: event.clientY }
    layer.classList.add('active')
    hint.style.display = 'none'
  })

  window.addEventListener(
    'mousemove',
    (event) => {
      if (!start) return
      const x = Math.min(start.x, event.clientX)
      const y = Math.min(start.y, event.clientY)
      const width = Math.abs(event.clientX - start.x)
      const height = Math.abs(event.clientY - start.y)
      rect = { x, y, width, height }
      Object.assign(box.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
      Object.assign(size.style, { display: 'block', left: `${x}px`, top: `${Math.max(0, y - 24)}px` })
      size.textContent = `${Math.round(width)} × ${Math.round(height)}`
    },
    true
  )

  window.addEventListener(
    'mouseup',
    () => {
      if (!start) return
      start = null
      cleanup()
      if (!rect || rect.width < 5 || rect.height < 5) return
      const selection = { ...rect, viewportWidth: window.innerWidth }
      // Wait two frames so the overlay is really gone from the screen
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setTimeout(() => chrome.runtime.sendMessage({ type: 'selection-done', rect: selection }), 30)
        )
      )
    },
    true
  )
})()
