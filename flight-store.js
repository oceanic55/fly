/* Flight Log — file storage + local draft.
 * Fetch the canonical NDJSON file, keep an automatic localStorage draft, save
 * by download (all browsers) or in place via the File System Access API
 * (desktop Chromium after the user links the data folder once).
 */
;(function (root) {
  'use strict'

  const DRAFT_KEY = 'flights-db-v2'
  const UNDO_KEY = 'flights-db-v2-undo'
  const LEGACY_KEY = 'flights-db-v1'
  const DRAFT_VERSION = 2
  const DATA_DIR = 'data/'
  // One canonical file holds both record shapes: flights first, then airports.
  // `parseImport` splits them back apart on load.
  const FILES = { data: 'flights.ndjson' }

  const DB_NAME = 'flight-log-fs'
  const DB_STORE = 'handles'
  const DIR_KEY = 'dataDir'

  const core = root.FlightCore

  function hash(text) {
    let h = 0x811c9dc5
    const str = String(text == null ? '' : text)
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (error) {
      console.error('localStorage write failed:', error)
      return false
    }
  }

  function makeDraft(state) {
    return {
      schemaVersion: DRAFT_VERSION,
      flights: state.flights || [],
      airports: state.airports || [],
      baseHash: state.baseHash || '',
      dirty: !!state.dirty,
      source: state.source || 'files',
      savedAt: new Date().toISOString(),
    }
  }

  function readDraft() {
    const draft = readJSON(DRAFT_KEY)
    if (!draft || draft.schemaVersion !== DRAFT_VERSION) return null
    if (!Array.isArray(draft.flights) || !Array.isArray(draft.airports)) return null
    return draft
  }

  function writeDraft(state) {
    return writeJSON(DRAFT_KEY, makeDraft(state))
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ }
  }

  function saveUndo(state) {
    return writeJSON(UNDO_KEY, makeDraft({ ...state, dirty: true, source: 'undo' }))
  }

  function readUndo() {
    const draft = readJSON(UNDO_KEY)
    if (!draft || draft.schemaVersion !== DRAFT_VERSION) return null
    return draft
  }

  function clearUndo() {
    try { localStorage.removeItem(UNDO_KEY) } catch { /* ignore */ }
  }

  /** Legacy cache from the Supabase era. Returns null unless it has data. */
  function migrateV1() {
    const legacy = readJSON(LEGACY_KEY)
    if (!legacy || (!Array.isArray(legacy.flights) && !Array.isArray(legacy.airports))) return null
    if (!legacy.flights || !legacy.flights.length) return null
    return {
      flights: legacy.flights,
      airports: Array.isArray(legacy.airports) ? legacy.airports : [],
    }
  }

  function clearLegacy() {
    try { localStorage.removeItem(LEGACY_KEY) } catch { /* ignore */ }
  }

  async function readDataFile(filename) {
    const url = DATA_DIR + filename
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) {
        return { ok: false, status: response.status, error: `HTTP ${response.status} for ${url}` }
      }
      const text = await response.text()
      const parsed = core.parseImport(text)
      return { ok: true, text, parsed }
    } catch (error) {
      return { ok: false, error: `${url}: ${error && error.message ? error.message : error}` }
    }
  }

  /**
   * Load the single canonical file. A file that cannot be found yet is a normal
   * first-run state (`missing`), not an error; a file that is found but cannot
   * be parsed is a real problem (`errors`). The same file carries both flights
   * and airports; a flights-only file simply has no airport records.
   */
  async function loadFiles() {
    const result = await readDataFile(FILES.data)

    const errors = []
    const missing = []
    let flights = []
    let airports = []

    if (result.ok) {
      flights = result.parsed.flights || []
      airports = result.parsed.airports || []
      for (const error of result.parsed.errors || []) {
        errors.push(`${FILES.data}${error.line ? ` line ${error.line}` : ''}: ${error.message}`)
      }
    } else {
      missing.push(FILES.data)
    }

    const canonical = core.serializeData(flights, airports)

    return {
      flights,
      airports,
      errors,
      missing,
      // The file was readable, so the page has something to show.
      anyRead: result.ok,
      ok: result.ok,
      hash: hash(canonical),
    }
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/x-ndjson;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  // ── File System Access API (optional) ──────────────────────────────────────
  const supportsFolder = () => typeof root.showDirectoryPicker === 'function'

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'))
        return
      }
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) {
          request.result.createObjectStore(DB_STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  async function idbGet(key) {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly')
      const request = tx.objectStore(DB_STORE).get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  }

  async function idbSet(key, value) {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
    })
  }

  async function idbDelete(key) {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).delete(key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
    })
  }

  async function getSavedFolder() {
    if (!supportsFolder()) return null
    try {
      return await idbGet(DIR_KEY)
    } catch {
      return null
    }
  }

  async function linkFolder() {
    if (!supportsFolder()) return null
    const handle = await root.showDirectoryPicker({ id: 'flight-data', mode: 'readwrite' })
    if (!handle) return null
    try {
      await idbSet(DIR_KEY, handle)
    } catch (error) {
      console.warn('Could not remember the data folder:', error)
    }
    return handle
  }

  async function ensurePermission(handle) {
    if (!handle) return false
    const options = { mode: 'readwrite' }
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission(options)
      if (state === 'granted') return true
    }
    if (typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission(options)) === 'granted'
    }
    return false
  }

  async function saveToFolder(handle, files) {
    if (!handle) throw new Error('No data folder linked')
    for (const [filename, text] of Object.entries(files)) {
      const fileHandle = await handle.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(text)
      await writable.close()
    }
    return true
  }

  async function forgetFolder() {
    try { await idbDelete(DIR_KEY) } catch { /* ignore */ }
  }

  root.FlightStore = {
    DRAFT_KEY,
    FILES,
    DATA_DIR,
    hash,
    readDraft,
    writeDraft,
    clearDraft,
    saveUndo,
    readUndo,
    clearUndo,
    migrateV1,
    clearLegacy,
    loadFiles,
    download,
    supportsFolder,
    getSavedFolder,
    linkFolder,
    ensurePermission,
    saveToFolder,
    forgetFolder,
  }
})(typeof window !== 'undefined' ? window : globalThis)
