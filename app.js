// ─── Supabase config ────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://sswwadgaygrbadqcgyxq.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzd3dhZGdheWdyYmFkcWNneXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzMTY1NzIsImV4cCI6MjEwMDg5MjU3Mn0.cJ5EZD1Pinfx-Vqp_j_9vU_44uV-0lw4kSxKpjED70w'

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Expose for one-time data migration from the browser console:
//   await window._sb.from('flights').upsert(window.SEED_DATA.flights)
//   await window._sb.from('airports').upsert(window.SEED_DATA.airports)
window._sb = sb

// ─── App state ──────────────────────────────────────────────────────────────
const storeKey = 'flights-db-v1'
let flights = []
let airports = []
let selectedYear = null
let selectedYearFlightId = null
let _ownerSession = null   // set by initAuth; used by save() and applyAuthUI()

const $ = id => document.getElementById(id)
const normCode = value => String(value || '').trim().toUpperCase()
const normText = value => String(value || '').trim()
const unique = values => [...new Set(values.filter(Boolean))]

// ─── Data loading ────────────────────────────────────────────────────────────
async function loadInitialData() {
  try {
    const [{ data: remoteFlights, error: fe }, { data: remoteAirports, error: ae }] = await Promise.all([
      sb.from('flights').select('*').order('date'),
      sb.from('airports').select('*').order('iata'),
    ])
    if (!fe && !ae && remoteFlights && remoteAirports) {
      flights  = remoteFlights
      airports = mergeAirportMetadata(remoteAirports)
      localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))
      setSyncStatus('Synced')
      return
    }
    if (_ownerSession) {
      setSyncStatus(`Server read failed: ${(fe || ae).message || 'unknown error'} — showing local data`, true)
    }
  } catch (err) {
    if (_ownerSession) setSyncStatus(`Server unavailable: ${err?.message || err} — showing local data`, true)
  }

  // Offline / Supabase unavailable — use localStorage cache, then seed
  const saved = localStorage.getItem(storeKey)
  if (saved) {
    const parsed = JSON.parse(saved)
    flights  = parsed.flights  || []
    airports = mergeAirportMetadata(parsed.airports || [])
    return
  }
  flights  = [...window.SEED_DATA.flights]
  airports = [...window.SEED_DATA.airports]
}

function mergeAirportMetadata(savedAirports) {
  const seedByCode = new Map(window.SEED_DATA.airports.map(a => [normCode(a.iata), a]))
  const merged = savedAirports.map(a => ({ ...seedByCode.get(normCode(a.iata)), ...a }))
  const savedCodes = new Set(merged.map(a => normCode(a.iata)))
  for (const airport of window.SEED_DATA.airports) {
    if (!savedCodes.has(normCode(airport.iata))) merged.push(airport)
  }
  return merged
}

// ─── Sync status ──────────────────────────────────────────────────────────────
function setSyncStatus(message, isError) {
  const el = $('syncStatus')
  if (!el) return
  el.textContent = message
  el.classList.toggle('hidden', !message)
  el.classList.toggle('error', !!isError)
}

// ─── Persistence ─────────────────────────────────────────────────────────────
async function save() {
  // Always update the local cache
  localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))

  // Remote write — only when authenticated
  if (!_ownerSession) {
    setSyncStatus('Signed out — changes saved on this device only', true)
    return false
  }
  const [{ error: fe }, { error: ae }] = await Promise.all([
    sb.from('flights').upsert(flights),
    sb.from('airports').upsert(airports),
  ])
  if (fe || ae) {
    const msg = (fe || ae).message
    console.error('Supabase sync error:', msg)
    setSyncStatus(`Sync failed: ${msg} — saved on this device only`, true)
    return false
  }
  setSyncStatus('Synced')
  return true
}

async function deleteFlight(id) {
  flights = flights.filter(f => f.id !== id)
  localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))
  if (!_ownerSession) {
    setSyncStatus('Signed out — delete saved on this device only', true)
    return
  }
  const { error } = await sb.from('flights').delete().eq('id', id)
  if (error) {
    console.error('Supabase delete error:', error.message)
    setSyncStatus(`Delete failed to sync: ${error.message}`, true)
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession()
  _ownerSession = session
  applyAuthUI(session)

  sb.auth.onAuthStateChange((_event, session) => {
    _ownerSession = session
    applyAuthUI(session)
    renderAll()
  })

  $('signInBtn').addEventListener('click', () =>
    sb.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: window.location.href }
    })
  )
  $('signOutBtn').addEventListener('click', () => sb.auth.signOut())
}

function applyAuthUI(session) {
  const isOwner = !!session
  $('authStatus').textContent = isOwner
    ? `${session.user.user_metadata.user_name ?? session.user.email}`
    : ''
  $('signInBtn').classList.toggle('hidden', isOwner)
  $('signOutBtn').classList.toggle('hidden', !isOwner)

  // Import hidden for guests; Data entry tab always visible (local writes work without auth)
  const importLabel = $('importLabel')
  if (importLabel) importLabel.classList.toggle('hidden', !isOwner)
}

// ─── Real-time sync ──────────────────────────────────────────────────────────
function subscribeRealtime() {
  sb.channel('flights-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flights' }, async () => {
      const { data, error } = await sb.from('flights').select('*').order('date')
      if (!error && data) {
        flights = data
        localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))
        setSyncStatus('Synced')
        renderAll()
      }
    })
    .subscribe()
}

// ─── Stats & rendering ───────────────────────────────────────────────────────
function countryMap() {
  return new Map(airports.map(a => [normCode(a.iata), normText(a.country)]))
}

function airportMap() {
  return new Map(airports.map(a => [normCode(a.iata), a]))
}

function flightYear(flight) {
  if (!flight.date) return null
  const year = new Date(`${flight.date}T00:00:00`).getFullYear()
  return Number.isFinite(year) ? year : null
}

function calculateStats() {
  const countriesByAirport = countryMap()
  const validFlights = flights.filter(f => f.date || f.departure || f.arrival || f.airline || f.aircraft)
  const airportCodes = unique(validFlights.flatMap(f => [normCode(f.departure), normCode(f.arrival)]))
  const arrivalCountries = unique(validFlights.map(f => countriesByAirport.get(normCode(f.arrival))))
  const airlines = unique(validFlights.map(f => normText(f.airline).toUpperCase()))
  const aircraft = unique(validFlights.map(f => normText(f.aircraft)))
  const byYear = {}
  for (const f of validFlights) {
    const year = flightYear(f)
    if (!year) continue
    byYear[year] = (byYear[year] || 0) + 1
  }
  return {
    countries: arrivalCountries.length,
    airports: airportCodes.length,
    totalFlights: validFlights.filter(f => countriesByAirport.get(normCode(f.arrival))).length,
    airlines: airlines.length,
    knownAircraft: aircraft.length,
    byYear,
  }
}

function renderDashboard() {
  const stats = calculateStats()
  $('statCards').innerHTML = [
    ['Countries', stats.countries],
    ['Airports', stats.airports],
    ['Total planes taken', stats.totalFlights],
    ['Airlines', stats.airlines],
    ['Known aircraft', stats.knownAircraft],
  ].map(([label, value]) =>
    `<div class="stat-chip"><strong>${value}</strong><span>${label}</span></div>`
  ).join('')

  const years = Object.keys(stats.byYear).map(Number).sort((a, b) => a - b)
  $('byYear').innerHTML = years.map(y =>
    `<tr><td><button class="year-link" data-year="${y}">${y}</button></td><td>${stats.byYear[y]}</td></tr>`
  ).join('')

  if (selectedYear) renderYearDetails(selectedYear)
}

function renderYearDetails(year) {
  selectedYear = year
  const rows = flights.filter(f => flightYear(f) === year)
  $('yearDetailsTitle').textContent = `Flights in ${year}`
  selectedYearFlightId = null
  $('yearFlightRows').innerHTML = rows.map(f => flightTableRow(f, { clickable: true })).join('')
}

function renderFlightDetail(id) {
  const f = flights.find(row => row.id === id)
  if (!f) return
  selectedYearFlightId = id
  const amap = airportMap()
  const dep = amap.get(normCode(f.departure)) || {}
  const arr = amap.get(normCode(f.arrival)) || {}
  const full = ap => [ap.name, ap.city, ap.country].filter(Boolean).join(', ') || '—'
  $('yearDetailsTitle').textContent = `${f.departure} → ${f.arrival}`
  $('yearFlightRows').innerHTML = `<tr><td colspan="9">
    <div class="flight-detail">
      <button class="detail-back" type="button" data-back-year>← Back</button>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Date</span><span class="detail-value">${escapeHtml(f.date || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Airline</span><span class="detail-value">${escapeHtml(f.airline || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Aircraft</span><span class="detail-value">${escapeHtml(f.aircraft || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Departure airport</span><span class="detail-value">${escapeHtml(full(dep))}</span></div>
        <div class="detail-item"><span class="detail-label">Arrival airport</span><span class="detail-value">${escapeHtml(full(arr))}</span></div>
      </div>
    </div>
  </td></tr>`
}

// ─── Airport name formatter ───────────────────────────────────────────────────
// Removes the word "Airport", shortens "International" → "Intl", trims noise.
function shortAirportName(name) {
  if (!name) return ''
  return name
    .replace(/\bInternational\b/gi, 'Intl')
    .replace(/\bAirport\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[,\-–]\s*$/, '')
    .trim()
}

function flightTableRow(f, options = {}) {
  const amap = airportMap()
  const dep  = amap.get(normCode(f.departure)) || {}
  const arr  = amap.get(normCode(f.arrival))   || {}
  const rowAttrs = options.clickable ? ` class="clickable-row" data-edit-flight="${f.id}"` : ''
  return `
    <tr${rowAttrs}>
      <td>${escapeHtml(f.date)}</td>
      <td>${escapeHtml(f.departure)}</td>
      <td>${escapeHtml(f.arrival)}</td>
      <td>${escapeHtml(shortAirportName(dep.name))}</td>
      <td>${escapeHtml(shortAirportName(arr.name))}</td>
      <td>${escapeHtml(arr.city || '')}</td>
      <td>${escapeHtml(arr.country || '')}</td>
      <td>${escapeHtml(f.airline)}</td>
      <td>${escapeHtml(f.aircraft)}</td>
    </tr>`
}

function renderFlights() {
  const q = normText($('flightSearch').value).toLowerCase()
  const rows = flights.filter(f => {
    const dep = airportMap().get(normCode(f.departure)) || {}
    const arr = airportMap().get(normCode(f.arrival)) || {}
    const haystack = (
      JSON.stringify(f) + ' ' +
      (dep.city || '') + ' ' + (dep.name || '') + ' ' + (dep.country || '') + ' ' +
      (arr.city || '') + ' ' + (arr.name || '') + ' ' + (arr.country || '')
    ).toLowerCase()
    return haystack.includes(q)
  })
  $('flightRows').innerHTML = rows.map(f => flightTableRow(f, { clickable: true })).join('')
}

function renderAll() {
  renderDashboard()
  renderFlights()
}

// ─── Form helpers ─────────────────────────────────────────────────────────────
function clearFlightForm() {
  $('flightId').value = ''
  $('flightForm').reset()
  $('deleteFlight').classList.add('hidden')
  $('arrivalCity').textContent = ''
  document.querySelectorAll('tr.editing').forEach(el => el.classList.remove('editing'))
}

function editFlight(id) {
  const f = flights.find(row => row.id === id)
  if (!f) return
  $('flightId').value   = f.id
  $('date').value       = f.date
  $('departure').value  = f.departure
  $('arrival').value    = f.arrival
  $('airline').value    = f.airline
  $('aircraft').value   = f.aircraft
  updateCityHint()
  $('deleteFlight').classList.remove('hidden')
  document.querySelectorAll('.tab,.panel').forEach(el => el.classList.remove('active'))
  document.querySelector('[data-tab="entry"]').classList.add('active')
  $('entry').classList.add('active')
  window.scrollTo({ top: 0, behavior: 'smooth' })

  // Highlight the clicked row and scroll it into view
  document.querySelectorAll('tr.editing').forEach(el => el.classList.remove('editing'))
  // Row may be in either the dashboard year-details table or the entry table
  setTimeout(() => {
    const row = document.querySelector(`[data-edit-flight="${CSS.escape(id)}"]`)
    if (row) {
      row.classList.add('editing')
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, 50)
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  )
}

function updateCityHint() {
  const code = normCode($('arrival').value)
  const ap = airportMap().get(code)
  $('arrivalCity').textContent = ap ? [ap.city, ap.country].filter(Boolean).join(', ') : ''
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function wireEvents() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(button =>
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab,.panel').forEach(el => el.classList.remove('active'))
      button.classList.add('active')
      $(button.dataset.tab).classList.add('active')
    })
  )

  // Flight form submit (add / edit)
  $('flightForm').addEventListener('submit', async event => {
    event.preventDefault()
    await ensureAirportKnown($('departure').value)
    await ensureAirportKnown($('arrival').value)
    const id = $('flightId').value || `f${Date.now()}`
    const flight = {
      id,
      date:      $('date').value,
      departure: normCode($('departure').value),
      arrival:   normCode($('arrival').value),
      airline:   normText($('airline').value),
      aircraft:  normText($('aircraft').value),
    }
    const idx = flights.findIndex(f => f.id === id)
    if (idx >= 0) flights[idx] = flight
    else flights.push(flight)
    await save()
    clearFlightForm()
    renderAll()
  })

  $('clearFlight').addEventListener('click', clearFlightForm)

  $('deleteFlight').addEventListener('click', async () => {
    const id = $('flightId').value
    if (!id || !confirm('Delete this selected flight?')) return
    await deleteFlight(id)
    clearFlightForm()
    renderAll()
  })

  $('flightSearch').addEventListener('input', renderFlights)
  $('arrival').addEventListener('input', updateCityHint)

  $('closeYearDetails').addEventListener('click', () => {
    selectedYear = null
    $('yearDetailsTitle').textContent = 'Select a year'
    $('yearFlightRows').innerHTML = '<tr><td colspan="9">Click a year on the left to show its flights here.</td></tr>'
  })

  document.body.addEventListener('click', event => {
    const year = event.target.dataset.year
    const backYear = event.target.closest('[data-back-year]')
    const dashboardFlightId = event.target.closest('#yearFlightRows [data-edit-flight]')?.dataset.editFlight
    const entryFlightId = event.target.closest('#flightRows [data-edit-flight]')?.dataset.editFlight
    if (year) renderYearDetails(Number(year))
    if (backYear && selectedYear) renderYearDetails(selectedYear)
    if (dashboardFlightId) renderFlightDetail(dashboardFlightId)
    if (entryFlightId) editFlight(entryFlightId)
  })

  // Export
  $('exportJson').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ flights, airports }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'flights-backup.json'
    a.click()
    URL.revokeObjectURL(a.href)
  })

  // Import
  $('importJson').addEventListener('change', async event => {
    const file = event.target.files[0]
    if (!file) return
    const parsed = JSON.parse(await file.text())
    flights  = parsed.flights  || []
    airports = parsed.airports || []
    await save()
    renderAll()
    event.target.value = ''
  })
}

// ─── Airport lookup ──────────────────────────────────────────────────────────
async function ensureAirportKnown(value) {
  const iata = normCode(value)
  if (!iata || airportMap().has(iata)) return
  const lookedUp = await lookupAirportOnline(iata)
  if (lookedUp) {
    airports.push(lookedUp)
    return
  }
  const country = prompt(`No airport data found for ${iata}. Enter country, or leave blank to skip.`)
  if (!country) return
  const city = prompt(`City for ${iata}?`, '') || ''
  const name = prompt(`Airport name for ${iata}?`, '') || ''
  airports.push({ iata, name: normText(name), city: normText(city), country: normText(country) })
}

async function lookupAirportOnline(iata) {
  try {
    const query = `
      SELECT ?airport ?airportLabel ?cityLabel ?countryLabel WHERE {
        ?airport wdt:P238 "${iata}".
        OPTIONAL { ?airport wdt:P931 ?city. }
        OPTIONAL { ?airport wdt:P17 ?country. }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } LIMIT 1`
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`
    const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } })
    if (!response.ok) return null
    const data = await response.json()
    const result = data.results?.bindings?.[0]
    if (!result?.countryLabel?.value) return null
    return {
      iata,
      name:    normText(result.airportLabel?.value),
      city:    normText(result.cityLabel?.value),
      country: normText(result.countryLabel.value),
    }
  } catch {
    return null
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
initAuth()
  .then(() => loadInitialData())
  .then(() => {
    subscribeRealtime()
    wireEvents()
    renderAll()
  })
