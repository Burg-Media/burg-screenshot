'use strict'

// Minimal PDF writer: each page is one JPEG image.
// No external library needed.

const BurgPdf = (() => {
  const A4 = { width: 595.28, height: 841.89 } // points
  const MAX_PT = 14400 // maximum page side in PDF

  const encoder = new TextEncoder()

  async function canvasToJpeg(canvas, quality = 0.9) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    return new Uint8Array(await blob.arrayBuffer())
  }

  /**
   * @param pages [{ jpeg: Uint8Array, pixelWidth, pixelHeight, pageWidth, pageHeight, drawHeight }]
   */
  function build(pages) {
    const chunks = []
    const offsets = []
    let length = 0
    const push = (data) => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data
      chunks.push(bytes)
      length += bytes.length
    }
    const object = (id, body, stream) => {
      offsets[id] = length
      push(`${id} 0 obj\n${body}\n`)
      if (stream) {
        push('stream\n')
        push(stream)
        push('\nendstream\n')
      }
      push('endobj\n')
    }

    // Object numbers: 1 catalog, 2 pages, then 3 per page: page, contents, image
    const pageIds = pages.map((_, i) => 3 + i * 3)
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
    object(1, '<< /Type /Catalog /Pages 2 0 R >>')
    object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`)

    pages.forEach((page, i) => {
      const pageId = pageIds[i]
      const contentId = pageId + 1
      const imageId = pageId + 2
      const w = page.pageWidth.toFixed(2)
      const h = page.pageHeight.toFixed(2)
      const dh = page.drawHeight.toFixed(2)
      // Place the image at the top of the page
      const content = encoder.encode(`q ${w} 0 0 ${dh} 0 ${(page.pageHeight - page.drawHeight).toFixed(2)} cm /Im0 Do Q`)
      object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${contentId} 0 R /Resources << /XObject << /Im0 ${imageId} 0 R >> >> >>`
      )
      object(contentId, `<< /Length ${content.length} >>`, content)
      object(
        imageId,
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
        page.jpeg
      )
    })

    const xrefOffset = length
    const count = offsets.length
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
    push(xref)
    push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

    return new Blob(chunks, { type: 'application/pdf' })
  }

  /** One long page the size of the screenshot (scaled down if it is too long). */
  async function singlePage(bitmap) {
    let pageWidth = bitmap.width * 0.75
    let pageHeight = bitmap.height * 0.75
    const fit = Math.min(1, MAX_PT / pageWidth, MAX_PT / pageHeight)
    pageWidth *= fit
    pageHeight *= fit
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
    return build([
      { jpeg: await canvasToJpeg(canvas), pixelWidth: canvas.width, pixelHeight: canvas.height, pageWidth, pageHeight, drawHeight: pageHeight },
    ])
  }

  /** Split over A4 pages (portrait), image at page width. */
  async function a4(bitmaps) {
    const pages = []
    for (const bitmap of [].concat(bitmaps)) {
      const pxPerPage = Math.floor((bitmap.width * A4.height) / A4.width)
      for (let y = 0; y < bitmap.height; y += pxPerPage) {
        const sliceHeight = Math.min(pxPerPage, bitmap.height - y)
        const canvas = new OffscreenCanvas(bitmap.width, sliceHeight)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(bitmap, 0, y, bitmap.width, sliceHeight, 0, 0, bitmap.width, sliceHeight)
        pages.push({
          jpeg: await canvasToJpeg(canvas),
          pixelWidth: bitmap.width,
          pixelHeight: sliceHeight,
          pageWidth: A4.width,
          pageHeight: A4.height,
          drawHeight: (sliceHeight * A4.width) / bitmap.width,
        })
      }
    }
    return build(pages)
  }

  return { singlePage, a4 }
})()
