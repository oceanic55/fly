// ─── Flight Log — desktop app ───────────────────────────────────────────────
// Flight and airport records share the canonical data/flights.ndjson file.
// localStorage holds an automatic unsaved draft. Save downloads the files, or
// writes them in place on Chromium after linking the data folder.
// Shared parsing/aggregation lives in flight-core.js / flight-store.js.

const core = window.FlightCore
const store = window.FlightStore

const {
  normCode,
  normText,
  escapeHtml: esc,
  shortAirportName,
  flightYear,
  sortByDateDesc,
  sortByDateAsc,
  flightsForIds,
} = core

const $ = id => document.getElementById(id)

// ─── App state ──────────────────────────────────────────────────────────────
let flights = []
let airports = []
let agg = null
let fileHash = ''
let dirty = false
let airportsDirty = false
let statusActions = []

let selectedYear = null
let selectedYearFlightId = null
let yearSort = 'newest'
let entryDateSort = 'newest'

let selectedAirport = null
let selectedCountry = null
let selectedAirline = null
let airportBreakdown = null
let countryBreakdown = null
let airlineBreakdown = null

let airportQuery = ''
let countryQuery = ''
let airlineQuery = ''

let pendingDraft = null
let pendingLegacy = null

// ─── Status banner ──────────────────────────────────────────────────────────
function setStatus(message, kind, actions) {
  const el = $('fileStatus')
  if (!el) return
  statusActions = actions || []
  el.className = 'file-status' + (kind ? ` ${kind}` : '') + (message ? '' : ' hidden')
  el.innerHTML = message
    ? `<span class="status-text">${esc(message)}</span>` +
      (statusActions.length
        ? `<span class="status-actions">${statusActions
            .map((action, index) => `<button type="button" data-status-action="${index}">${esc(action.label)}</button>`)
            .join('')}</span>`
        : '')
    : ''
}

function updateDirtyUI() {
  document.title = (dirty ? '• ' : '') + '✈ FLY'
  const button = $('saveData')
  if (button) button.classList.toggle('dirty', dirty)
}

function persistDraft(source) {
  store.writeDraft({ flights, airports, baseHash: fileHash, dirty, source: source || 'files' })
}

function markDirty(message) {
  dirty = true
  persistDraft()
  updateDirtyUI()
  if (message) setStatus(message, 'warn')
}

function adoptData(nextFlights, nextAirports, options) {
  const opts = options || {}
  const validated = core.validateData(nextFlights, nextAirports)
  flights = validated.flights
  airports = validated.airports
  dirty = opts.dirty !== false
  airportsDirty = !!opts.airportsChanged
  persistDraft(opts.source || 'files')
  renderAll()
  updateDirtyUI()
  return validated
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const airportMap = () => new Map(airports.map(a => [normCode(a.iata), a]))

function matches(haystack, query) {
  if (!query) return true
  return String(haystack || '').toLowerCase().includes(query.toLowerCase())
}

function dateOrDash(date) {
  return date || '—'
}

function airportLabel(code) {
  const airport = airportMap().get(normCode(code)) || {}
  const name = shortAirportName(airport.name)
  return name ? `${esc(code)} · ${esc(name)}` : esc(code)
}

// ─── Stats & dashboard ──────────────────────────────────────────────────────
function renderStats() {
  const totals = agg.totals
  const chips = [
    { value: totals.flights, label: 'Flights', view: 'dashboard' },
    { value: totals.airports, label: 'Airports', view: 'airports' },
    { value: totals.countries, label: 'Countries', view: 'countries' },
    { value: totals.airlines, label: 'Airlines', view: 'airlines' },
    { value: totals.aircraft, label: 'Aircraft', view: '' },
  ]
  $('statCards').innerHTML = chips.map(chip => {
    const content = `<strong>${chip.value}</strong><span>${chip.label}</span>`
    return chip.view
      ? `<button type="button" class="stat-chip clickable" data-view="${chip.view}" aria-label="${chip.label}: ${chip.value}">${content}</button>`
      : `<div class="stat-chip">${content}</div>`
  }).join('')
}

function renderDashboard() {
  const yearRows = [...agg.byYear].sort((a, b) =>
    yearSort === 'oldest' ? a.year - b.year : b.year - a.year
  )
  $('byYear').innerHTML = yearRows.length
    ? `<tr><td><button type="button" class="year-link" data-year="all">ALL</button></td><td>${agg.totals.flights}</td></tr>` + yearRows.map(row =>
      `<tr><td><button type="button" class="year-link" data-year="${row.year}">${row.year}</button></td><td>${row.count}</td></tr>`
    ).join('')
    : '<tr><td colspan="2" class="empty-cell">No flights yet.</td></tr>'

  if (selectedYear) {
    renderYearDetails(selectedYear, true)
    return
  }

  if (!agg.byYear.length) {
    $('yearDetailsTitle').textContent = 'No flights yet'
    $('yearFlightRows').innerHTML =
      '<tr><td colspan="9" class="empty-cell">Add your first flight in Data entry, or import a data file.</td></tr>'
  }
}

function renderYearDetails(year, keepFlight) {
  selectedYear = year
  if (!keepFlight) selectedYearFlightId = null
  const allYears = year === 'all'
  const rows = allYears
    ? flights.slice().sort(sortByDateAsc)
    : flights.filter(f => flightYear(f) === year).sort(sortByDateDesc)
  $('yearDetailsTitle').textContent = allYears ? 'All flights · oldest first' : `Flights in ${year}`
  if (selectedYearFlightId && rows.some(f => f.id === selectedYearFlightId)) {
    renderFlightDetail(selectedYearFlightId)
    return
  }
  selectedYearFlightId = null
  let rowsHtml = ''
  let currentYear = null
  for (const flight of rows) {
    const yearGroup = flightYear(flight)
    if (allYears && yearGroup && yearGroup !== currentYear) {
      currentYear = yearGroup
      rowsHtml += `<tr class="year-group-row"><td colspan="9">${yearGroup}</td></tr>`
    }
    rowsHtml += flightTableRow(flight, { clickable: true })
  }
  $('yearFlightRows').innerHTML = rows.length
    ? rowsHtml
    : '<tr><td colspan="9" class="empty-cell">No flights in this year.</td></tr>'
}

function renderFlightDetail(id) {
  const flight = flights.find(row => row.id === id)
  if (!flight) return
  selectedYearFlightId = id
  const map = airportMap()
  const dep = map.get(normCode(flight.departure)) || {}
  const arr = map.get(normCode(flight.arrival)) || {}
  const full = airport => [airport.name, airport.city, airport.country].filter(Boolean).join(', ') || '—'
  $('yearDetailsTitle').textContent = `${flight.departure} → ${flight.arrival}`
  $('yearFlightRows').innerHTML = `<tr><td colspan="9">
    <div class="flight-detail">
      <button class="detail-back" type="button" data-back-year>← Back to ${selectedYear}</button>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Date</span><span class="detail-value">${esc(flight.date || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Airline</span><span class="detail-value">${esc(flight.airline || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Aircraft</span><span class="detail-value">${esc(flight.aircraft || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Departure airport</span><span class="detail-value">${esc(full(dep))}</span></div>
        <div class="detail-item"><span class="detail-label">Arrival airport</span><span class="detail-value">${esc(full(arr))}</span></div>
      </div>
    </div>
  </td></tr>`
}

function flightTableRow(flight, options) {
  const opts = options || {}
  const map = airportMap()
  const dep = map.get(normCode(flight.departure)) || {}
  const arr = map.get(normCode(flight.arrival)) || {}
  const attrs = opts.clickable
    ? ` class="clickable-row${selectedYearFlightId === flight.id ? ' editing' : ''}" data-edit-flight="${esc(flight.id)}"`
    : ''
  return `
    <tr${attrs}>
      <td>${esc(flight.date)}</td>
      <td>${esc(flight.departure)}</td>
      <td>${esc(flight.arrival)}</td>
      <td>${esc(shortAirportName(dep.name))}</td>
      <td>${esc(shortAirportName(arr.name))}</td>
      <td>${esc(arr.city || '')}</td>
      <td>${esc(arr.country || '')}</td>
      <td>${esc(flight.airline)}</td>
      <td>${esc(flight.aircraft)}</td>
    </tr>`
}

function renderFlights() {
  const query = normText($('flightSearch').value).toLowerCase()
  const map = airportMap()
  const rows = flights.filter(flight => {
    const dep = map.get(normCode(flight.departure)) || {}
    const arr = map.get(normCode(flight.arrival)) || {}
    const haystack = (
      JSON.stringify(flight) + ' ' +
      [dep.city, dep.name, dep.country, arr.city, arr.name, arr.country].join(' ')
    ).toLowerCase()
    return haystack.includes(query)
  }).sort(entryDateSort === 'oldest' ? sortByDateAsc : sortByDateDesc)

  $('flightRows').innerHTML = rows.length
    ? rows.map(flight => flightTableRow(flight, { clickable: true })).join('')
    : flights.length
      ? '<tr><td colspan="9" class="empty-cell">No flights match.</td></tr>'
      : '<tr><td colspan="9" class="empty-cell">No flights yet — add one above.</td></tr>'
}

// ─── Breakdown tables ───────────────────────────────────────────────────────
function breakdownTable(rows, mode, key) {
  if (!rows.length) return '<div class="empty-state">No flights recorded.</div>'
  const map = airportMap()
  const columns = mode === 'airline' ? 5 : 6
  const head = mode === 'airport'
    ? '<tr><th>Date</th><th>Direction</th><th>Route</th><th>Other airport</th><th>Airline</th><th>Aircraft</th></tr>'
    : mode === 'country'
      ? '<tr><th>Date</th><th>Route</th><th>Arrival airport</th><th>City</th><th>Airline</th><th>Aircraft</th></tr>'
      : '<tr><th>Date</th><th>Route</th><th>City</th><th>Country</th><th>Aircraft</th></tr>'
  const widths = mode === 'airport'
    ? ['96px', '78px', '132px', null, '190px', '130px']
    : mode === 'country'
      ? ['96px', '132px', null, '150px', '190px', '130px']
      : ['96px', '132px', '180px', '180px', '130px']
  const colgroup = `<colgroup>${widths.map(width => `<col${width ? ` style="width:${width}"` : ''}>`).join('')}</colgroup>`

  let html = `<table class="breakdown-table">${colgroup}<thead>${head}</thead><tbody>`
  let currentYear = null
  for (const flight of rows) {
    const year = flightYear(flight)
    if (year && year !== currentYear) {
      currentYear = year
      html += `<tr class="year-group-row"><td colspan="${columns}">${year}</td></tr>`
    }
    const dep = map.get(normCode(flight.departure)) || {}
    const arr = map.get(normCode(flight.arrival)) || {}
    const route = `<span class="route">${esc(flight.departure)} → ${esc(flight.arrival)}</span>`

    if (mode === 'airport') {
      const isDeparture = normCode(flight.departure) === key
      const otherCode = isDeparture ? flight.arrival : flight.departure
      const other = isDeparture ? arr : dep
      const otherText = [otherCode, shortAirportName(other.name), other.city, other.country].filter(Boolean).join(' · ')
      html += `<tr class="clickable-row" data-breakdown-flight="${esc(flight.id)}">
        <td>${esc(dateOrDash(flight.date))}</td>
        <td><span class="dir-badge ${isDeparture ? 'dep' : 'arr'}">${isDeparture ? 'Out' : 'In'}</span></td>
        <td>${route}</td>
        <td>${esc(otherText || '—')}</td>
        <td>${esc(flight.airline || '—')}</td>
        <td>${esc(flight.aircraft || '—')}</td>
      </tr>`
    } else if (mode === 'country') {
      html += `<tr class="clickable-row" data-breakdown-flight="${esc(flight.id)}">
        <td>${esc(dateOrDash(flight.date))}</td>
        <td>${route}</td>
        <td>${esc(flight.arrival)}${shortAirportName(arr.name) ? ` · ${esc(shortAirportName(arr.name))}` : ''}</td>
        <td>${esc(arr.city || '—')}</td>
        <td>${esc(flight.airline || '—')}</td>
        <td>${esc(flight.aircraft || '—')}</td>
      </tr>`
    } else {
      html += `<tr class="clickable-row" data-breakdown-flight="${esc(flight.id)}">
        <td>${esc(dateOrDash(flight.date))}</td>
        <td>${route}</td>
        <td>${esc(arr.city || '—')}</td>
        <td>${esc(arr.country || '—')}</td>
        <td>${esc(flight.aircraft || '—')}</td>
      </tr>`
    }
  }
  return html + '</tbody></table>'
}

function breakdownFlightHtml(flight, backLabel) {
  const map = airportMap()
  const dep = map.get(normCode(flight.departure)) || {}
  const arr = map.get(normCode(flight.arrival)) || {}
  const full = airport => [airport.name, airport.city, airport.country].filter(Boolean).join(', ') || '—'
  return `<button class="detail-back" type="button" data-breakdown-back>${esc(backLabel)}</button>
    <div class="flight-detail">
      <div class="detail-route">${esc(flight.departure)} <span class="fc-arrow">→</span> ${esc(flight.arrival)}</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Date</span><span class="detail-value">${esc(flight.date || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Airline</span><span class="detail-value">${esc(flight.airline || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Aircraft</span><span class="detail-value">${esc(flight.aircraft || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Departure airport</span><span class="detail-value">${esc(full(dep))}</span></div>
        <div class="detail-item"><span class="detail-label">Arrival airport</span><span class="detail-value">${esc(full(arr))}</span></div>
      </div>
    </div>`
}

function summaryChips(items) {
  return `<div class="detail-stats">${items
    .filter(Boolean)
    .map(item => `<span class="detail-stat"><strong>${esc(item.value)}</strong> ${esc(item.label)}</span>`)
    .join('')}</div>`
}

// ─── Airports view ──────────────────────────────────────────────────────────
function renderAirportsIndex() {
  const rows = agg.byAirport.filter(group =>
    matches([group.code, group.name, group.city, group.country].join(' '), airportQuery)
  ).sort((a, b) => a.code.localeCompare(b.code))

  $('airportsTotal').textContent = `${agg.byAirport.length} airports · ${agg.totals.flights} flights`
  $('airportRows').innerHTML = rows.length
    ? rows.map(group => `<tr class="clickable-row${selectedAirport === group.code ? ' active-row' : ''}" data-airport="${esc(group.code)}">
        <td class="idx-name"><strong>${esc(group.code)}</strong> <span class="muted">${esc(shortAirportName(group.name)) || 'Unknown'}</span></td>
        <td>${esc(group.country || '—')}</td>
        <td class="num">${group.departures}</td>
        <td class="num">${group.arrivals}</td>
        <td class="num"><strong>${group.total}</strong></td>
        <td>${esc(dateOrDash(group.last))}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty-cell">No airports match.</td></tr>'
}

function renderAirportDetail() {
  const title = $('airportDetailTitle')
  const body = $('airportDetailBody')
  if (!title || !body) return

  if (airportBreakdown) {
    const flight = flights.find(row => row.id === airportBreakdown)
    if (flight) {
      title.textContent = `${flight.departure} → ${flight.arrival}`
      body.innerHTML = breakdownFlightHtml(flight, `← Back to ${selectedAirport || 'airport'}`)
      return
    }
    airportBreakdown = null
  }

  if (!selectedAirport) {
    title.textContent = 'Select an airport'
    body.innerHTML = '<div class="empty-state">Click an airport in the list to see its flights by date.</div>'
    return
  }

  const group = agg.byAirport.find(row => row.code === selectedAirport)
  if (!group) {
    selectedAirport = null
    title.textContent = 'Select an airport'
    body.innerHTML = '<div class="empty-state">Click an airport in the list to see its flights by date.</div>'
    return
  }

  const rows = flightsForIds(flights, group.flightIds)
  title.textContent = `${group.code} · ${shortAirportName(group.name) || 'Unknown airport'}`
  body.innerHTML = `
    <div class="detail-head">
      <div class="detail-sub">${esc([group.city, group.country].filter(Boolean).join(', ') || 'Location unknown')}</div>
      ${summaryChips([
        { value: group.total, label: 'flights' },
        { value: group.departures, label: 'departures' },
        { value: group.arrivals, label: 'arrivals' },
        { value: `${dateOrDash(group.first)} → ${dateOrDash(group.last)}`, label: '' },
      ])}
    </div>
    ${breakdownTable(rows, 'airport', group.code)}`
}

// ─── Countries view ─────────────────────────────────────────────────────────
function renderCountriesIndex() {
  const rows = agg.byCountry.filter(group =>
    matches([group.country, group.airportCodes.join(' ')].join(' '), countryQuery)
  ).sort((a, b) => a.country.localeCompare(b.country))

  $('countriesTotal').textContent = `${agg.byCountry.length} countries · ${agg.totals.flights} flights`
  $('countryRows').innerHTML = rows.length
    ? rows.map(group => `<tr class="clickable-row${selectedCountry === group.country ? ' active-row' : ''}" data-country="${esc(group.country)}">
        <td><strong>${esc(group.country)}</strong></td>
        <td class="num">${group.airportCount}</td>
        <td class="num"><strong>${group.arrivals}</strong></td>
        <td class="num">${group.departures}</td>
        <td>${esc(dateOrDash(group.first))}</td>
        <td>${esc(dateOrDash(group.last))}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty-cell">No countries match.</td></tr>'
}

function renderCountryDetail() {
  const title = $('countryDetailTitle')
  const body = $('countryDetailBody')
  if (!title || !body) return

  if (countryBreakdown) {
    const flight = flights.find(row => row.id === countryBreakdown)
    if (flight) {
      title.textContent = `${flight.departure} → ${flight.arrival}`
      body.innerHTML = breakdownFlightHtml(flight, `← Back to ${selectedCountry || 'country'}`)
      return
    }
    countryBreakdown = null
  }

  if (!selectedCountry) {
    title.textContent = 'Select a country'
    body.innerHTML = '<div class="empty-state">Click a country in the list to see its flights by date.</div>'
    return
  }

  const group = agg.byCountry.find(row => row.country === selectedCountry)
  if (!group) {
    selectedCountry = null
    title.textContent = 'Select a country'
    body.innerHTML = '<div class="empty-state">Click a country in the list to see its flights by date.</div>'
    return
  }

  const rows = flightsForIds(flights, group.flightIds)
  const counts = new Map()
  for (const flight of rows) counts.set(flight.arrival, (counts.get(flight.arrival) || 0) + 1)
  const airportChips = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `<button type="button" class="airport-chip" data-jump-airport="${esc(code)}">${esc(code)} <strong>${count}</strong></button>`)
    .join('')

  title.textContent = group.country
  body.innerHTML = `
    <div class="detail-head">
      ${summaryChips([
        { value: group.arrivals, label: 'flights' },
        { value: group.airportCount, label: 'airports' },
        { value: group.departures, label: 'departures' },
        { value: `${dateOrDash(group.first)} → ${dateOrDash(group.last)}`, label: '' },
      ])}
      ${airportChips ? `<div class="chip-row">${airportChips}</div>` : ''}
    </div>
    ${breakdownTable(rows, 'country', group.country)}`
}

// ─── Airlines view ──────────────────────────────────────────────────────────
function renderAirlinesIndex() {
  const rows = agg.byAirline.filter(group =>
    matches([group.airline, group.countries.join(' '), group.aircraft.map(a => a.name).join(' ')].join(' '), airlineQuery)
  ).sort((a, b) => a.airline.localeCompare(b.airline))

  $('airlinesTotal').textContent = `${agg.byAirline.length} airlines · ${agg.totals.flights} flights`
  $('airlineRows').innerHTML = rows.length
    ? rows.map(group => `<tr class="clickable-row${selectedAirline === group.airline ? ' active-row' : ''}" data-airline="${esc(group.airline)}">
        <td><strong>${esc(group.airline)}</strong></td>
        <td class="num"><strong>${group.flights}</strong></td>
        <td class="num">${group.airportCount}</td>
        <td class="num">${group.countryCount}</td>
        <td>${esc(dateOrDash(group.last))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty-cell">No airlines match.</td></tr>'
}

function renderAirlineDetail() {
  const title = $('airlineDetailTitle')
  const body = $('airlineDetailBody')
  if (!title || !body) return

  if (airlineBreakdown) {
    const flight = flights.find(row => row.id === airlineBreakdown)
    if (flight) {
      title.textContent = `${flight.departure} → ${flight.arrival}`
      body.innerHTML = breakdownFlightHtml(flight, `← Back to ${selectedAirline || 'airline'}`)
      return
    }
    airlineBreakdown = null
  }

  if (!selectedAirline) {
    title.textContent = 'Select an airline'
    body.innerHTML = '<div class="empty-state">Click an airline in the list to see its flights by date.</div>'
    return
  }

  const group = agg.byAirline.find(row => row.airline === selectedAirline)
  if (!group) {
    selectedAirline = null
    title.textContent = 'Select an airline'
    body.innerHTML = '<div class="empty-state">Click an airline in the list to see its flights by date.</div>'
    return
  }

  const rows = flightsForIds(flights, group.flightIds)
  const aircraftChips = group.aircraft
    .map(item => `<span class="aircraft-chip">${esc(item.known ? item.name : 'Unknown')} <strong>${item.count}</strong></span>`)
    .join('')

  title.textContent = group.airline
  body.innerHTML = `
    <div class="detail-head">
      ${summaryChips([
        { value: group.flights, label: 'flights' },
        { value: group.airportCount, label: 'airports' },
        { value: group.countryCount, label: 'countries' },
        { value: `${dateOrDash(group.first)} → ${dateOrDash(group.last)}`, label: '' },
      ])}
      ${aircraftChips ? `<div class="chip-row">${aircraftChips}</div>` : ''}
    </div>
    ${breakdownTable(rows, 'airline', group.airline)}`
}

// ─── Render everything ──────────────────────────────────────────────────────
function renderAll() {
  agg = core.aggregate(flights, airports)
  renderStats()
  renderDashboard()
  renderFlights()
  renderAirportsIndex()
  renderAirportDetail()
  renderCountriesIndex()
  renderCountryDetail()
  renderAirlinesIndex()
  renderAirlineDetail()
}

// ─── Form helpers ───────────────────────────────────────────────────────────
function clearFlightForm() {
  $('flightId').value = ''
  $('flightForm').reset()
  $('deleteFlight').classList.add('hidden')
  $('arrivalCity').textContent = ''
  document.querySelectorAll('tr.editing').forEach(el => el.classList.remove('editing'))
}

function editFlight(id) {
  const flight = flights.find(row => row.id === id)
  if (!flight) return
  $('flightId').value = flight.id
  $('date').value = flight.date
  $('dateYear').value = flight.date.slice(0, 4)
  $('departure').value = flight.departure
  $('arrival').value = flight.arrival
  $('airline').value = flight.airline
  $('aircraft').value = flight.aircraft
  updateCityHint()
  $('deleteFlight').classList.remove('hidden')

  switchTab('entry')
  window.scrollTo({ top: 0, behavior: 'smooth' })

  document.querySelectorAll('tr.editing').forEach(el => el.classList.remove('editing'))
  setTimeout(() => {
    const row = document.querySelector(`[data-edit-flight="${CSS.escape(id)}"]`)
    if (row) {
      row.classList.add('editing')
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, 50)
}

function updateCityHint() {
  const airport = airportMap().get(normCode($('arrival').value))
  $('arrivalCity').textContent = airport ? [airport.city, airport.country].filter(Boolean).join(', ') : ''
}

// ─── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(button =>
    button.classList.toggle('active', button.dataset.tab === name)
  )
  document.querySelectorAll('.panel').forEach(panel =>
    panel.classList.toggle('active', panel.id === name)
  )
}

// ─── Events ─────────────────────────────────────────────────────────────────
function wireEvents() {
  document.querySelectorAll('.tab').forEach(button =>
    button.addEventListener('click', () => switchTab(button.dataset.tab))
  )

  // Stat chips → views
  $('statCards').addEventListener('click', event => {
    const chip = event.target.closest('[data-view]')
    if (chip) switchTab(chip.dataset.view)
  })

  // Flight form (add / edit)
  $('flightForm').addEventListener('submit', async event => {
    event.preventDefault()
    const departure = normCode($('departure').value)
    const arrival = normCode($('arrival').value)
    await ensureAirportKnown(departure)
    await ensureAirportKnown(arrival)

    const id = $('flightId').value || core.makeId()
    const flight = {
      id,
      date: $('date').value,
      departure,
      arrival,
      airline: normText($('airline').value),
      aircraft: normText($('aircraft').value),
    }
    const index = flights.findIndex(row => row.id === id)
    if (index >= 0) flights[index] = flight
    else flights.push(flight)

    markDirty(`Unsaved changes · ${flights.length} flights — save to update data/`)
    clearFlightForm()
    renderAll()
  })

  $('clearFlight').addEventListener('click', clearFlightForm)

  $('deleteFlight').addEventListener('click', () => {
    const id = $('flightId').value
    if (!id || !confirm('Delete this selected flight?')) return
    flights = flights.filter(flight => flight.id !== id)
    markDirty('Flight deleted · save to update data/')
    clearFlightForm()
    renderAll()
  })

  $('flightSearch').addEventListener('input', renderFlights)
  $('entryDateSort').addEventListener('change', event => {
    entryDateSort = event.target.value
    renderFlights()
  })
  $('arrival').addEventListener('input', updateCityHint)

  $('date').addEventListener('input', event => {
    $('dateYear').value = event.target.value.slice(0, 4)
  })
  $('dateYear').addEventListener('change', event => {
    const updated = core.dateInYear($('date').value, event.target.value)
    if (updated) {
      $('date').value = updated
      event.target.value = updated.slice(0, 4)
    } else {
      event.target.value = $('date').value.slice(0, 4)
    }
  })

  $('closeYearDetails').addEventListener('click', () => {
    selectedYear = null
    selectedYearFlightId = null
    $('yearDetailsTitle').textContent = 'Select a year'
    $('yearFlightRows').innerHTML = '<tr><td colspan="9" class="empty-cell">Click a year on the left to show its flights here.</td></tr>'
  })

  $('yearSort').addEventListener('change', event => {
    yearSort = event.target.value
    renderDashboard()
  })

  // Index search / sort
  $('airportSearch').addEventListener('input', event => {
    airportQuery = event.target.value
    renderAirportsIndex()
  })
  $('countrySearch').addEventListener('input', event => {
    countryQuery = event.target.value
    renderCountriesIndex()
  })
  $('airlineSearch').addEventListener('input', event => {
    airlineQuery = event.target.value
    renderAirlinesIndex()
  })

  $('closeAirportDetail').addEventListener('click', () => {
    selectedAirport = null
    airportBreakdown = null
    renderAirportsIndex()
    renderAirportDetail()
  })
  $('closeCountryDetail').addEventListener('click', () => {
    selectedCountry = null
    countryBreakdown = null
    renderCountriesIndex()
    renderCountryDetail()
  })
  $('closeAirlineDetail').addEventListener('click', () => {
    selectedAirline = null
    airlineBreakdown = null
    renderAirlinesIndex()
    renderAirlineDetail()
  })

  document.body.addEventListener('click', event => {
    const year = event.target.dataset && event.target.dataset.year
    const backYear = event.target.closest('[data-back-year]')
    const dashboardFlightId = event.target.closest('#yearFlightRows [data-edit-flight]')?.dataset.editFlight
    const entryFlightId = event.target.closest('#flightRows [data-edit-flight]')?.dataset.editFlight
    const airportRow = event.target.closest('[data-airport]')
    const countryRow = event.target.closest('[data-country]')
    const airlineRow = event.target.closest('[data-airline]')
    const jumpAirport = event.target.closest('[data-jump-airport]')
    const breakdownRow = event.target.closest('[data-breakdown-flight]')
    const breakdownBack = event.target.closest('[data-breakdown-back]')

    if (year) {
      selectedYearFlightId = null
      renderYearDetails(year === 'all' ? 'all' : Number(year))
    }
    if (backYear && selectedYear) {
      selectedYearFlightId = null
      renderYearDetails(selectedYear)
    }
    if (dashboardFlightId) renderFlightDetail(dashboardFlightId)
    if (entryFlightId) editFlight(entryFlightId)

    if (airportRow) {
      selectedAirport = airportRow.dataset.airport
      airportBreakdown = null
      renderAirportsIndex()
      renderAirportDetail()
    }
    if (countryRow) {
      selectedCountry = countryRow.dataset.country
      countryBreakdown = null
      renderCountriesIndex()
      renderCountryDetail()
    }
    if (airlineRow) {
      selectedAirline = airlineRow.dataset.airline
      airlineBreakdown = null
      renderAirlinesIndex()
      renderAirlineDetail()
    }
    if (jumpAirport) {
      selectedAirport = jumpAirport.dataset.jumpAirport
      airportBreakdown = null
      switchTab('airports')
      renderAirportsIndex()
      renderAirportDetail()
    }
    if (breakdownRow) {
      const id = breakdownRow.dataset.breakdownFlight
      if (event.target.closest('#airportDetailBody')) {
        airportBreakdown = id
        renderAirportDetail()
      } else if (event.target.closest('#countryDetailBody')) {
        countryBreakdown = id
        renderCountryDetail()
      } else if (event.target.closest('#airlineDetailBody')) {
        airlineBreakdown = id
        renderAirlineDetail()
      }
    }
    if (breakdownBack) {
      if (event.target.closest('#airportDetailBody')) {
        airportBreakdown = null
        renderAirportDetail()
      } else if (event.target.closest('#countryDetailBody')) {
        countryBreakdown = null
        renderCountryDetail()
      } else if (event.target.closest('#airlineDetailBody')) {
        airlineBreakdown = null
        renderAirlineDetail()
      }
    }
  })

  // Status banner actions
  $('fileStatus').addEventListener('click', event => {
    const button = event.target.closest('[data-status-action]')
    if (!button) return
    const action = statusActions[Number(button.dataset.statusAction)]
    if (action && typeof action.fn === 'function') action.fn()
  })

  // Save / export / import
  $('saveData').addEventListener('click', saveToFile)

  $('exportJson').addEventListener('click', () => {
    const payload = JSON.stringify({ flights, airports }, null, 2)
    store.download('flights-backup.json', payload + '\n', 'application/json;charset=utf-8')
    setStatus('Downloaded flights-backup.json', 'ok')
  })

  $('importJson').addEventListener('change', async event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    await handleImport(file)
  })

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      saveToFile()
    }
  })

  window.addEventListener('beforeunload', event => {
    if (!dirty) return
    event.preventDefault()
    event.returnValue = ''
  })
}

// ─── Save / import ──────────────────────────────────────────────────────────
async function saveToFile() {
  // One file holds both shapes: flights first, then airports.
  const dataText = core.serializeData(flights, airports)
  const nextHash = store.hash(dataText)

  if (store.supportsFolder()) {
    let handle = null
    try {
      handle = await store.getSavedFolder()
    } catch {
      handle = null
    }

    if (!handle) {
      const wantsFolder = confirm('Save directly into your data/ folder?\n\nOK: choose the folder (Chromium/Edge).\nCancel: download the file instead.')
      if (wantsFolder) {
        try {
          handle = await store.linkFolder()
        } catch (error) {
          console.warn('Folder link cancelled or failed:', error)
        }
      }
    }

    if (handle) {
      try {
        if (!(await store.ensurePermission(handle))) throw new Error('Folder permission was not granted')
        await store.saveToFolder(handle, { [store.FILES.data]: dataText })
        fileHash = nextHash
        dirty = false
        store.writeDraft({ flights, airports, baseHash: fileHash, dirty: false, source: 'files' })
        updateDirtyUI()
        setStatus(`Saved to the linked data folder · ${flights.length} flights`, 'ok')
        return
      } catch (error) {
        console.warn('Folder save failed; falling back to download:', error)
      }
    }
  }

  store.download(store.FILES.data, dataText)
  fileHash = nextHash
  dirty = false
  store.writeDraft({ flights, airports, baseHash: fileHash, dirty: false, source: 'files' })
  updateDirtyUI()
  setStatus(`Downloaded ${store.FILES.data} — replace it in ${store.DATA_DIR}`, 'warn')
}

async function handleImport(file) {
  let text
  try {
    text = await file.text()
  } catch (error) {
    setStatus(`Could not read ${file.name}: ${error.message}`, 'error')
    return
  }

  const parsed = core.parseImport(text)
  if (!parsed.flights && !parsed.airports) {
    const detail = parsed.errors.length ? parsed.errors[0].message : 'no flight or airport records found'
    setStatus(`Import failed: ${detail}`, 'error')
    return
  }

  const nextFlights = parsed.flights && parsed.flights.length ? parsed.flights : flights
  const nextAirports = parsed.airports && parsed.airports.length ? parsed.airports : airports

  const parts = []
  if (parsed.flights) parts.push(`flights ${flights.length} → ${parsed.flights.length}`)
  if (parsed.airports) parts.push(`airports ${airports.length} → ${parsed.airports.length}`)
  if (!parsed.airports && airports.length) parts.push('airport details kept')
  const target = [
    parsed.flights ? 'flights' : null,
    parsed.airports ? 'airports' : null,
  ].filter(Boolean).join(' and ')
  if (!confirm(`Replace ${target}?\n\n${parts.join(' · ')}\n\nA one-step undo is kept.`)) return

  store.saveUndo({ flights, airports, baseHash: fileHash })
  const validated = adoptData(
    nextFlights,
    nextAirports,
    { dirty: true, airportsChanged: true, source: 'import' }
  )

  const warnings = (parsed.errors || []).length + validated.warnings.length
  const summary = parsed.airports || !airports.length
    ? `Imported ${flights.length} flights and ${airports.length} airports`
    : `Imported ${flights.length} flights · kept ${airports.length} airport records`
  setStatus(
    `${summary}${warnings ? ` · ${warnings} warning(s)` : ''}`,
    warnings ? 'warn' : 'ok',
    [{ label: 'Undo import', fn: undoImport }]
  )
}

function undoImport() {
  const undo = store.readUndo()
  if (!undo) {
    setStatus('Nothing to undo', 'warn')
    return
  }
  store.clearUndo()
  adoptData(undo.flights, undo.airports, { dirty: true, airportsChanged: true, source: 'import' })
  setStatus('Import undone — save to update data/', 'warn')
}

// ─── Airport lookup ─────────────────────────────────────────────────────────
async function ensureAirportKnown(value) {
  const iata = normCode(value)
  if (!iata || airports.some(airport => normCode(airport.iata) === iata)) return

  const lookedUp = await lookupAirportOnline(iata)
  if (lookedUp) {
    airports.push(lookedUp)
    airportsDirty = true
    return
  }

  const country = prompt(`No airport data found for ${iata}. Enter country, or leave blank to skip.`)
  if (!country) {
    airports.push({ iata, name: '', city: '', country: '' })
    airportsDirty = true
    return
  }
  const city = prompt(`City for ${iata}?`, '') || ''
  const name = prompt(`Airport name for ${iata}?`, '') || ''
  airports.push({ iata, name: normText(name), city: normText(city), country: normText(country) })
  airportsDirty = true
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
      name: normText(result.airportLabel?.value),
      city: normText(result.cityLabel?.value),
      country: normText(result.countryLabel.value),
    }
  } catch {
    return null
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  wireEvents()

  const loaded = await store.loadFiles()
  const draft = store.readDraft()
  const legacy = store.migrateV1()
  let usedDraft = false
  let usedLegacy = false
  let warnings = []

  // A data file that does not exist yet is a normal first run, not an error:
  // start from the cached draft if there is one, otherwise from an empty log.
  if (loaded.anyRead) {
    const validated = core.validateData(loaded.flights, loaded.airports)
    flights = validated.flights
    airports = validated.airports
    warnings = validated.warnings
    fileHash = store.hash(core.serializeData(flights, airports))

    if (draft && draft.dirty) {
      if (draft.baseHash === fileHash) {
        adoptData(draft.flights, draft.airports, { dirty: true, airportsChanged: true, source: 'draft' })
        usedDraft = true
      } else {
        pendingDraft = draft
      }
    } else if (!draft && legacy) {
      const legacyValidated = core.validateData(legacy.flights, legacy.airports)
      const legacyHash = store.hash(
        core.serializeData(legacyValidated.flights, legacyValidated.airports)
      )
      if (legacyHash === fileHash) {
        store.clearLegacy()
      } else {
        pendingLegacy = legacy
      }
    }
  } else if (draft) {
    adoptData(draft.flights, draft.airports, { dirty: !!draft.dirty, airportsChanged: true, source: 'draft' })
    usedDraft = true
  } else if (legacy) {
    adoptData(legacy.flights, legacy.airports, { dirty: true, airportsChanged: true, source: 'migration' })
    store.clearLegacy()
    usedLegacy = true
  } else {
    const validated = core.validateData(loaded.flights, loaded.airports)
    flights = validated.flights
    airports = validated.airports
    warnings = validated.warnings
    fileHash = store.hash(core.serializeData(flights, airports))
  }

  if (usedDraft || usedLegacy) {
    // adoptData already rendered.
  } else {
    renderAll()
  }
  updateDirtyUI()

  if (pendingDraft) {
    setStatus(
      `Local draft found (${pendingDraft.flights.length} flights) that does not match data/ — restore it or discard it`,
      'warn',
      [
        {
          label: 'Restore draft',
          fn: () => {
            adoptData(pendingDraft.flights, pendingDraft.airports, { dirty: true, airportsChanged: true, source: 'draft' })
            pendingDraft = null
            setStatus('Draft restored — save to update data/', 'warn')
          },
        },
        {
          label: 'Discard draft',
          fn: () => {
            store.clearDraft()
            pendingDraft = null
            setStatus('Draft discarded — using the data files', 'ok')
          },
        },
      ]
    )
  } else if (pendingLegacy) {
    setStatus(
      `Old local cache found (${pendingLegacy.flights.length} flights) that differs from data/`,
      'warn',
      [
        {
          label: 'Use local cache',
          fn: () => {
            adoptData(pendingLegacy.flights, pendingLegacy.airports, { dirty: true, airportsChanged: true, source: 'migration' })
            store.clearLegacy()
            pendingLegacy = null
            setStatus('Local cache imported — save to update data/', 'warn')
          },
        },
        {
          label: 'Ignore',
          fn: () => {
            store.clearLegacy()
            pendingLegacy = null
            setStatus('Old local cache ignored', 'ok')
          },
        },
      ]
    )
  } else if (loaded.errors.length) {
    setStatus(`Loaded ${flights.length} flights · ${loaded.errors[0]}`, 'warn')
    console.warn('Data file problems:', loaded.errors)
  } else if (warnings.length) {
    setStatus(
      `Loaded ${flights.length} flights · ${warnings.length} warning(s): ${warnings[0].message}`,
      'warn'
    )
    console.warn('Data warnings:', warnings)
  } else if (loaded.anyRead) {
    setStatus(`Loaded ${store.DATA_DIR}${store.FILES.data} · ${flights.length} flights`, 'ok')
  }
}

boot()
