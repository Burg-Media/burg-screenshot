'use strict'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const MODE_LABELS = { full: t('modeFull'), visible: t('modeVisible'), selection: t('modeSelection') }

localizePage()

let current = null // { meta, blob, url, siblings }

function notice(text) {
  $('notice').hidden = !text
  $('notice').textContent = text || ''
}

function formatDate(time) {
  return new Date(time).toLocaleString(t('locale'), { dateStyle: 'medium', timeStyle: 'short' })
}

function formatBytes(bytes) {
  const mb = (bytes / 1024 / 1024).toLocaleString(t('locale'), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${mb} MB`
}

function baseName(meta) {
  let host = 'screenshot'
  try {
    host = new URL(meta.url).hostname.replace(/^www\./, '')
  } catch (e) {
    // not a valid URL
  }
  const d = new Date(meta.createdAt)
  const pad = (n) => String(n).padStart(2, '0')
  return `${host}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

// ---------------------------------------------------------------------------
// One screenshot
// ---------------------------------------------------------------------------

async function showShot(id) {
  const [meta, blob] = await Promise.all([ShotDB.getMeta(id), ShotDB.getBlob(id)])
  if (!meta || !blob) {
    notice(t('notFound'))
    return showLibrary()
  }
  const siblings = meta.parts > 1 ? (await ShotDB.list()).filter((s) => s.group === meta.group).sort((a, b) => a.part - b.part) : [meta]
  current = { meta, blob, url: URL.createObjectURL(blob), siblings }
  document.title = `${meta.title || 'Screenshot'} · Burg Screenshot`

  $('shot-title').textContent = meta.title || meta.url
  $('shot-title').href = meta.url
  $('shot-title').title = meta.url
  $('shot-meta').textContent = [
    MODE_LABELS[meta.mode] || '',
    meta.parts > 1 ? t('partOf', meta.part, meta.parts) : '',
    `${meta.width} × ${meta.height} px`,
    formatBytes(blob.size),
    formatDate(meta.createdAt),
  ]
    .filter(Boolean)
    .join(' · ')
  $('shot-info').hidden = false
  $('shot-actions').hidden = false
  $('shot-view').hidden = false
  $('shot-image').src = current.url

  renderParts()
  if (meta.truncated) notice(t('truncated'))
}

function renderParts() {
  const nav = $('parts')
  nav.hidden = current.siblings.length < 2
  nav.replaceChildren()
  if (nav.hidden) return
  nav.append(t('partsIntro'))
  for (const sibling of current.siblings) {
    const link = document.createElement(sibling.id === current.meta.id ? 'strong' : 'a')
    link.textContent = t('partN', sibling.part)
    if (link.tagName === 'A') link.href = `viewer.html?id=${encodeURIComponent(sibling.id)}`
    nav.append(link, ' ')
  }
  nav.append(t('partsPdf'))
}

/** Bitmaps of all parts (or only this screenshot). */
async function groupBitmaps() {
  const bitmaps = []
  for (const sibling of current.siblings) {
    bitmaps.push(await createImageBitmap(sibling.id === current.meta.id ? current.blob : await ShotDB.getBlob(sibling.id)))
  }
  return bitmaps
}

$('shot-image').addEventListener('click', (event) => {
  // Click toggles between fit and actual size, and zooms in on the clicked spot
  const img = event.currentTarget
  const ratio = event.offsetY / img.clientHeight
  img.classList.toggle('fit')
  if (!img.classList.contains('fit')) {
    requestAnimationFrame(() => window.scrollTo({ top: img.offsetTop + img.clientHeight * ratio - innerHeight / 2 }))
  }
})

async function withBusy(button, task) {
  const label = button.textContent
  button.disabled = true
  button.textContent = t('busy')
  try {
    await task()
  } catch (error) {
    notice(t('failed', error.message))
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

const ACTIONS = {
  async compress() {
    const panel = $('compress')
    panel.hidden = !panel.hidden
    if (!panel.hidden && !compress.blob) await encodeCompressed()
  },
  async png() {
    const suffix = current.meta.parts > 1 ? `_${t('filePart')}-${current.meta.part}` : ''
    download(current.blob, `${baseName(current.meta)}${suffix}.png`)
  },
  async jpg() {
    const bitmap = await createImageBitmap(current.blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
    download(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }), `${baseName(current.meta)}.jpg`)
  },
  async 'pdf-a4'() {
    download(await BurgPdf.a4(await groupBitmaps()), `${baseName(current.meta)}.pdf`)
  },
  async 'pdf-single'() {
    download(await BurgPdf.singlePage(await createImageBitmap(current.blob)), `${baseName(current.meta)}.pdf`)
  },
  async copy() {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': current.blob })])
    notice(t('copied'))
    setTimeout(() => notice(''), 2500)
  },
  async delete() {
    for (const sibling of current.siblings) await ShotDB.remove(sibling.id)
    URL.revokeObjectURL(current.url)
    current = null
    history.replaceState(null, '', 'viewer.html')
    $('shot-info').hidden = $('shot-actions').hidden = $('shot-view').hidden = $('parts').hidden = $('compress').hidden = true
    notice(t('deleted'))
    showLibrary()
  },
}

// ---------------------------------------------------------------------------
// Compress: smaller file with live calculated size
// ---------------------------------------------------------------------------

const WEBP_MAX = 16383 // WebP cannot store a larger side
const compress = { bitmap: null, blob: null, job: 0, timer: null }

function loadCompressSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('compress') || '{}')
    if (saved.format) $('c-format').value = saved.format
    if (saved.quality) $('c-quality').value = saved.quality
    if (saved.width !== undefined) $('c-width').value = String(saved.width)
  } catch (e) {
    // no storage available
  }
  $('c-quality-out').textContent = $('c-quality').value
}

function saveCompressSettings() {
  try {
    localStorage.setItem(
      'compress',
      JSON.stringify({ format: $('c-format').value, quality: $('c-quality').value, width: Number($('c-width').value) })
    )
  } catch (e) {
    // no storage available
  }
}

function compressTarget() {
  const { width, height } = compress.bitmap
  const maxWidth = Number($('c-width').value) || width
  const scale = Math.min(1, maxWidth / width)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

async function encodeCompressed() {
  const job = ++compress.job
  compress.blob = null
  $('c-download').disabled = true
  $('c-result').textContent = t('calculating')

  if (!compress.bitmap) compress.bitmap = await createImageBitmap(current.blob)
  const target = compressTarget()
  let type = $('c-format').value
  let note = ''
  if (type === 'image/webp' && Math.max(target.width, target.height) > WEBP_MAX) {
    type = 'image/jpeg'
    note = t('webpTooLong')
  }

  const canvas = new OffscreenCanvas(target.width, target.height)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, target.width, target.height)
  }
  ctx.drawImage(compress.bitmap, 0, 0, target.width, target.height)
  const blob = await canvas.convertToBlob({ type, quality: Number($('c-quality').value) / 100 })
  if (job !== compress.job) return // another setting was chosen in the meantime

  compress.blob = blob
  const saving = Math.round((1 - blob.size / current.blob.size) * 100)
  $('c-result').replaceChildren(
    `${formatBytes(current.blob.size)} → ${formatBytes(blob.size)} `,
    Object.assign(document.createElement('span'), {
      className: saving > 0 ? 'saving' : '',
      textContent: saving > 0 ? `(−${saving}%)` : t('notSmaller'),
    }),
    ` · ${target.width} × ${target.height} px${note}`
  )
  $('c-download').disabled = false
}

function scheduleEncode() {
  $('c-quality-out').textContent = $('c-quality').value
  saveCompressSettings()
  clearTimeout(compress.timer)
  compress.timer = setTimeout(() => encodeCompressed().catch((error) => notice(t('failed', error.message))), 300)
}

for (const id of ['c-format', 'c-quality', 'c-width']) $(id).addEventListener('input', scheduleEncode)

$('c-download').addEventListener('click', () => {
  if (!compress.blob) return
  const extension = compress.blob.type === 'image/webp' ? 'webp' : 'jpg'
  const suffix = current.meta.parts > 1 ? `_${t('filePart')}-${current.meta.part}` : ''
  download(compress.blob, `${baseName(current.meta)}${suffix}_${t('fileSmall')}.${extension}`)
})

$('shot-actions').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]')
  if (button && current) withBusy(button, ACTIONS[button.dataset.action])
})

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function showLibrary() {
  document.title = `${t('myScreenshots')} · Burg Screenshot`
  $('library').hidden = false
  // Of split screenshots, show only the first part
  const all = await ShotDB.list()
  const shots = all.filter((shot) => !shot.parts || shot.part === 1)
  const grid = $('grid')
  grid.replaceChildren()

  if (!shots.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = t('libraryEmpty')
    grid.append(empty)
    return
  }

  for (const shot of shots) {
    const card = document.createElement('div')
    card.className = 'card'

    const thumb = document.createElement('a')
    thumb.className = 'thumb'
    thumb.href = `viewer.html?id=${encodeURIComponent(shot.id)}`
    if (shot.thumb) thumb.style.backgroundImage = `url(${URL.createObjectURL(shot.thumb)})`

    const body = document.createElement('div')
    body.className = 'body'
    const title = document.createElement('a')
    title.className = 'title'
    title.href = thumb.href
    title.textContent = shot.title || shot.url
    title.title = shot.url

    const meta = document.createElement('div')
    meta.className = 'meta'
    const info = document.createElement('span')
    info.textContent = `${formatDate(shot.createdAt)} · ${MODE_LABELS[shot.mode] || ''}${shot.parts > 1 ? ` · ${t('partsCount', shot.parts)}` : ''}`
    const remove = document.createElement('button')
    remove.textContent = t('remove')
    remove.addEventListener('click', async () => {
      for (const member of all.filter((s) => s.id === shot.id || (shot.group && s.group === shot.group))) {
        await ShotDB.remove(member.id)
      }
      card.remove()
      if (!grid.children.length) showLibrary()
    })
    meta.append(info, remove)
    body.append(title, meta)
    card.append(thumb, body)
    grid.append(card)
  }
}

// ---------------------------------------------------------------------------

loadCompressSettings()

if (params.get('id')) showShot(params.get('id'))
else showLibrary()
