'use strict'

// Local storage of screenshots in IndexedDB (only in this browser).
// Shared by the service worker (importScripts) and the viewer (<script>).
// 'meta' holds title/url/thumbnail, 'blobs' the full image, so the library
// can load without reading all the large images.

const ShotDB = (() => {
  let dbPromise = null

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('burg-screenshot', 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore('meta', { keyPath: 'id' })
          request.result.createObjectStore('blobs')
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return dbPromise
  }

  async function tx(stores, mode, action) {
    const db = await open()
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode)
      const request = action(t)
      t.oncomplete = () => resolve(request ? request.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  return {
    /** @param meta { id, url, title, createdAt, width, height, thumb } */
    save: (meta, blob) =>
      tx(['meta', 'blobs'], 'readwrite', (t) => {
        t.objectStore('blobs').put(blob, meta.id)
        t.objectStore('meta').put(meta)
      }),
    getMeta: (id) => tx('meta', 'readonly', (t) => t.objectStore('meta').get(id)),
    getBlob: (id) => tx('blobs', 'readonly', (t) => t.objectStore('blobs').get(id)),
    remove: (id) =>
      tx(['meta', 'blobs'], 'readwrite', (t) => {
        t.objectStore('meta').delete(id)
        t.objectStore('blobs').delete(id)
      }),
    /** All metadata, newest first. */
    async list() {
      const all = await tx('meta', 'readonly', (t) => t.objectStore('meta').getAll())
      return all.sort((a, b) => b.createdAt - a.createdAt)
    },
  }
})()
