/* Flight Log — shared core.
 * Pure data helpers: parsing, validation, serialization, aggregation.
 * No DOM, no storage, no network. Loaded as a classic script in both pages
 * and also require()-able from Node for tools/verify-data.mjs.
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.FlightCore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const FLIGHT_KEYS = ['id', 'date', 'departure', 'arrival', 'airline', 'aircraft']
  const AIRPORT_KEYS = ['iata', 'name', 'city', 'country']

  const normCode = v => String(v == null ? '' : v).trim().toUpperCase()
  const normText = v => String(v == null ? '' : v).trim()
  const unique = values => [...new Set(values.filter(Boolean))]

  function makeId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return 'f-' + crypto.randomUUID()
      }
    } catch { /* ignore */ }
    return 'f' + Date.now() + Math.random().toString(36).slice(2, 7)
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  function flightYear(flight) {
    const m = /^(\d{4})-/.exec(String((flight && flight.date) || ''))
    return m ? Number(m[1]) : null
  }

  /** yyyymmdd integer for sorting; 0 when the date is missing or invalid. */
  function dateValue(flightOrDate) {
    const raw = typeof flightOrDate === 'string'
      ? flightOrDate
      : String((flightOrDate && flightOrDate.date) || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 0
    const y = Number(raw.slice(0, 4))
    const mo = Number(raw.slice(5, 7))
    const da = Number(raw.slice(8, 10))
    const dt = new Date(Date.UTC(y, mo - 1, da))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return 0
    return y * 10000 + mo * 100 + da
  }

  const isValidDate = value => dateValue(value) > 0

  function dateInYear(date, yearValue) {
    const year = Number(yearValue)
    if (!Number.isInteger(year) || year < 1000 || year > 9999) return ''
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
    const month = match ? Number(match[2]) : 1
    const day = match ? Number(match[3]) : 1
    if (month < 1 || month > 12) return ''
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const validDay = Math.min(Math.max(day, 1), maxDay)
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(validDay).padStart(2, '0')}`
  }

  function isValidFlight(flight) {
    if (!flight) return false
    return !!(
      normText(flight.date) ||
      normCode(flight.departure) ||
      normCode(flight.arrival) ||
      normText(flight.airline) ||
      normText(flight.aircraft)
    )
  }

  function normalizeFlight(flight) {
    const src = flight && typeof flight === 'object' ? flight : {}
    return {
      id: normText(src.id) || makeId(),
      date: normText(src.date),
      departure: normCode(src.departure),
      arrival: normCode(src.arrival),
      airline: normText(src.airline),
      aircraft: normText(src.aircraft),
    }
  }

  function normalizeAirport(airport) {
    const src = airport && typeof airport === 'object' ? airport : {}
    return {
      iata: normCode(src.iata),
      name: normText(src.name),
      city: normText(src.city),
      country: normText(src.country),
    }
  }

  function idNumber(id) {
    const n = Number(String(id || '').replace(/\D/g, ''))
    return Number.isFinite(n) ? n : 0
  }

  function compareFlightsAsc(a, b) {
    const da = dateValue(a)
    const db = dateValue(b)
    if (da !== db) {
      if (!da) return 1
      if (!db) return -1
      return da - db
    }
    return idNumber(a.id) - idNumber(b.id) || String(a.id).localeCompare(String(b.id))
  }

  function sortByDateDesc(a, b) {
    const da = dateValue(a)
    const db = dateValue(b)
    if (da !== db) {
      if (!da) return 1
      if (!db) return -1
      return db - da
    }
    return idNumber(b.id) - idNumber(a.id) || String(b.id).localeCompare(String(a.id))
  }

  function sortByDateAsc(a, b) {
    const da = dateValue(a)
    const db = dateValue(b)
    if (da !== db) {
      if (!da) return 1
      if (!db) return -1
      return da - db
    }
    return idNumber(a.id) - idNumber(b.id) || String(a.id).localeCompare(String(b.id))
  }

  function serializeFlights(flights) {
    const rows = (flights || [])
      .filter(f => f && normText(f.id))
      .slice()
      .sort(compareFlightsAsc)
      .map(f => JSON.stringify({
        id: normText(f.id),
        date: normText(f.date),
        departure: normCode(f.departure),
        arrival: normCode(f.arrival),
        airline: normText(f.airline),
        aircraft: normText(f.aircraft),
      }))
    return rows.length ? rows.join('\n') + '\n' : ''
  }

  function serializeAirports(airports) {
    const rows = (airports || [])
      .filter(a => a && normCode(a.iata))
      .slice()
      .sort((a, b) => normCode(a.iata).localeCompare(normCode(b.iata)))
      .map(a => JSON.stringify({
        iata: normCode(a.iata),
        name: normText(a.name),
        city: normText(a.city),
        country: normText(a.country),
      }))
    return rows.length ? rows.join('\n') + '\n' : ''
  }

  /**
   * The canonical on-disk document: every flight, then every airport, as
   * NDJSON in one file. `parseImport` splits the shapes back apart on load.
   */
  function serializeData(flights, airports) {
    return serializeFlights(flights) + serializeAirports(airports)
  }

  /** Parse one JSON object per line. Blank lines are skipped. */
  function parseNdjson(text) {
    const items = []
    const errors = []
    const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/)
    lines.forEach((raw, index) => {
      const line = raw.trim()
      if (!line) return
      try {
        const parsed = JSON.parse(line)
        if (Array.isArray(parsed)) {
          for (const item of parsed) items.push(item)
        } else {
          items.push(parsed)
        }
      } catch (error) {
        errors.push({
          line: index + 1,
          message: error.message,
          raw: line.length > 180 ? line.slice(0, 180) + '…' : line,
        })
      }
    })
    return { items, errors }
  }

  function looksAirport(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false
    if (Object.prototype.hasOwnProperty.call(record, 'iata')) return true
    return !('departure' in record) && !('arrival' in record) &&
      ('name' in record || 'city' in record || 'country' in record)
  }

  function looksFlight(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false
    return 'departure' in record || 'arrival' in record || 'airline' in record ||
      'aircraft' in record || ('id' in record && !('iata' in record))
  }

  function splitRecords(records) {
    const flights = []
    const airports = []
    const errors = []
    for (const record of records) {
      if (looksAirport(record)) airports.push(record)
      else if (looksFlight(record)) flights.push(record)
      else errors.push({ message: 'Record is neither a flight nor an airport', raw: JSON.stringify(record).slice(0, 180) })
    }
    return { flights, airports, errors }
  }

  /**
   * Accepts NDJSON, a JSON array of flights or airports, a single record,
   * or the legacy combined {flights, airports} object.
   * flights/airports are null when that kind was not present in the input.
   */
  function parseImport(text) {
    const empty = { flights: null, airports: null, format: 'empty', errors: [] }
    const trimmed = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim()
    if (!trimmed) return empty

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        const whole = JSON.parse(trimmed)
        if (Array.isArray(whole)) {
          const split = splitRecords(whole)
          if (!split.flights.length && !split.airports.length) {
            return { flights: null, airports: null, format: 'json-array', errors: split.errors.length ? split.errors : [{ message: 'No flight or airport records found' }] }
          }
          return {
            flights: split.flights.length ? split.flights : null,
            airports: split.airports.length ? split.airports : null,
            format: 'json-array',
            errors: split.errors,
          }
        }
        if (whole && typeof whole === 'object') {
          if ('flights' in whole || 'airports' in whole) {
            return {
              flights: Array.isArray(whole.flights) ? whole.flights : null,
              airports: Array.isArray(whole.airports) ? whole.airports : null,
              format: 'combined',
              errors: [],
            }
          }
          const split = splitRecords([whole])
          return {
            flights: split.flights.length ? split.flights : null,
            airports: split.airports.length ? split.airports : null,
            format: 'json-record',
            errors: split.errors,
          }
        }
        return { flights: null, airports: null, format: 'json', errors: [{ message: 'Unsupported JSON value' }] }
      } catch {
        // Not a single JSON document — fall through to NDJSON.
      }
    }

    const parsed = parseNdjson(trimmed)
    const split = splitRecords(parsed.items)
    return {
      flights: split.flights.length ? split.flights : null,
      airports: split.airports.length ? split.airports : null,
      format: 'ndjson',
      errors: parsed.errors.concat(split.errors),
    }
  }

  /**
   * Normalize, dedupe, and validate. Never throws on bad input.
   * Unknown airport codes get blank stubs so views and future saves can see them.
   */
  function validateData(flightsInput, airportsInput) {
    const warnings = []
    const flights = []
    const seenIds = new Set()

    ;(flightsInput || []).forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push({ type: 'invalid-record', message: `Flight #${index + 1} is not an object — skipped` })
        return
      }
      const flight = normalizeFlight(raw)
      if (!isValidFlight(flight)) {
        warnings.push({ type: 'empty-flight', message: `Flight #${index + 1} has no data — skipped` })
        return
      }
      if (seenIds.has(flight.id)) {
        warnings.push({ type: 'duplicate-id', message: `Duplicate flight id "${flight.id}" — kept the first`, id: flight.id })
        return
      }
      seenIds.add(flight.id)

      if (flight.date) {
        if (!isValidDate(flight.date)) {
          warnings.push({ type: 'invalid-date', message: `${flight.id}: invalid date "${flight.date}"`, id: flight.id })
        } else {
          const year = Number(flight.date.slice(0, 4))
          const maxYear = new Date().getFullYear() + 1
          if (year < 2000 || year > maxYear) {
            warnings.push({ type: 'suspicious-date', message: `${flight.id}: suspicious year ${year}`, id: flight.id })
          }
        }
      }
      if (!flight.departure || !flight.arrival) {
        warnings.push({ type: 'missing-route', message: `${flight.id}: missing departure or arrival code`, id: flight.id })
      }
      flights.push(flight)
    })

    const airportMap = new Map()
    ;(airportsInput || []).forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push({ type: 'invalid-record', message: `Airport #${index + 1} is not an object — skipped` })
        return
      }
      const airport = normalizeAirport(raw)
      if (!airport.iata) {
        warnings.push({ type: 'invalid-airport', message: `Airport #${index + 1} has no IATA code — skipped` })
        return
      }
      if (airportMap.has(airport.iata)) {
        warnings.push({ type: 'duplicate-airport', message: `Duplicate airport "${airport.iata}" — kept the last`, iata: airport.iata })
      }
      airportMap.set(airport.iata, airport)
    })

    const unknown = new Set()
    for (const flight of flights) {
      for (const code of [flight.departure, flight.arrival]) {
        if (code && !airportMap.has(code)) {
          unknown.add(code)
          airportMap.set(code, { iata: code, name: '', city: '', country: '' })
        }
      }
    }
    if (unknown.size) {
      const codes = [...unknown].sort()
      const shown = codes.slice(0, 8).join(', ')
      const more = codes.length > 8 ? `, +${codes.length - 8} more` : ''
      warnings.push({
        type: 'unknown-airports',
        message:
          `${codes.length} ${codes.length === 1 ? 'airport has' : 'airports have'} no details (${shown}${more}) — ` +
          "country totals can't be counted. Add airport details with country names in Data entry.",
        codes,
      })
    }

    return { flights, airports: [...airportMap.values()], warnings }
  }

  function aggregate(flightsInput, airportsInput) {
    const flights = (flightsInput || []).filter(isValidFlight)
    const airportMap = new Map((airportsInput || []).map(a => [normCode(a.iata), a]))

    const countryOf = code => {
      const airport = airportMap.get(normCode(code))
      return airport ? normText(airport.country) : ''
    }

    const byYearMap = new Map()
    const byAirportMap = new Map()
    const byCountryMap = new Map()
    const byAirlineMap = new Map()
    const byAircraftMap = new Map()
    let firstDate = ''
    let lastDate = ''
    let unknownAircraft = 0

    function touchDate(group, date, arrivalDate) {
      if (!date) return
      if (!group.first || date < group.first) group.first = date
      if (!group.last || date > group.last) group.last = date
      if (arrivalDate && (!group.lastArrival || arrivalDate > group.lastArrival)) group.lastArrival = arrivalDate
    }

    for (const flight of flights) {
      const date = isValidDate(flight.date) ? flight.date : ''
      if (date) {
        if (!firstDate || date < firstDate) firstDate = date
        if (!lastDate || date > lastDate) lastDate = date
      }

      const year = flightYear(flight)
      if (year) byYearMap.set(year, (byYearMap.get(year) || 0) + 1)

      const dep = normCode(flight.departure)
      const arr = normCode(flight.arrival)

      // Airports: a flight contributes one departure and one arrival.
      for (const [code, direction] of [[dep, 'departures'], [arr, 'arrivals']]) {
        if (!code) continue
        let group = byAirportMap.get(code)
        if (!group) {
          const meta = airportMap.get(code) || {}
          group = {
            code,
            name: normText(meta.name),
            city: normText(meta.city),
            country: normText(meta.country),
            departures: 0,
            arrivals: 0,
            total: 0,
            first: '',
            last: '',
            flightIds: [],
          }
          byAirportMap.set(code, group)
        }
        group[direction] += 1
        group.total += 1
        touchDate(group, date, direction === 'arrivals' ? date : null)
        if (!group.flightIds.includes(flight.id)) group.flightIds.push(flight.id)
      }

      // Countries: rows come from arrival countries (visited).
      const arrCountry = countryOf(arr)
      if (arrCountry) {
        let group = byCountryMap.get(arrCountry)
        if (!group) {
          group = {
            country: arrCountry,
            airportCodes: new Set(),
            arrivals: 0,
            departures: 0,
            first: '',
            last: '',
            lastArrival: '',
            flightIds: [],
          }
          byCountryMap.set(arrCountry, group)
        }
        group.arrivals += 1
        if (arr) group.airportCodes.add(arr)
        touchDate(group, date, date)
        if (!group.flightIds.includes(flight.id)) group.flightIds.push(flight.id)
      }

      // Airline
      const airlineKey = normText(flight.airline).toUpperCase()
      if (airlineKey) {
        let group = byAirlineMap.get(airlineKey)
        if (!group) {
          group = {
            airline: normText(flight.airline),
            flights: 0,
            airportCodes: new Set(),
            countries: new Set(),
            aircraftCounts: new Map(),
            first: '',
            last: '',
            flightIds: [],
          }
          byAirlineMap.set(airlineKey, group)
        }
        group.flights += 1
        if (dep) group.airportCodes.add(dep)
        if (arr) group.airportCodes.add(arr)
        const country = countryOf(arr)
        if (country) group.countries.add(country)
        const aircraft = normText(flight.aircraft)
        group.aircraftCounts.set(aircraft, (group.aircraftCounts.get(aircraft) || 0) + 1)
        touchDate(group, date, date)
        if (!group.flightIds.includes(flight.id)) group.flightIds.push(flight.id)
      }

      // Aircraft
      const aircraft = normText(flight.aircraft)
      if (aircraft) {
        byAircraftMap.set(aircraft, (byAircraftMap.get(aircraft) || 0) + 1)
      } else {
        unknownAircraft += 1
      }
    }

    // Secondary pass: departure counts and first/last for the countries already listed.
    for (const flight of flights) {
      const depCountry = countryOf(flight.departure)
      if (!depCountry) continue
      const group = byCountryMap.get(depCountry)
      if (!group) continue
      group.departures += 1
      if (isValidDate(flight.date)) touchDate(group, flight.date, null)
    }

    const byYear = [...byYearMap.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => b.year - a.year)

    const byAirport = [...byAirportMap.values()]
      .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code))

    const byCountry = [...byCountryMap.values()]
      .map(group => ({
        country: group.country,
        airportCodes: [...group.airportCodes].sort(),
        airportCount: group.airportCodes.size,
        arrivals: group.arrivals,
        departures: group.departures,
        first: group.first,
        last: group.last,
        lastArrival: group.lastArrival,
        flightIds: group.flightIds,
      }))
      .sort((a, b) => b.arrivals - a.arrivals || a.country.localeCompare(b.country))

    const byAirline = [...byAirlineMap.values()]
      .map(group => ({
        airline: group.airline,
        flights: group.flights,
        airportCodes: [...group.airportCodes].sort(),
        airportCount: group.airportCodes.size,
        countries: [...group.countries].sort(),
        countryCount: group.countries.size,
        aircraft: [...group.aircraftCounts.entries()]
          .map(([name, count]) => ({ name, count, known: !!name }))
          .sort((a, b) => (b.known - a.known) || b.count - a.count || a.name.localeCompare(b.name)),
        first: group.first,
        last: group.last,
        flightIds: group.flightIds,
      }))
      .sort((a, b) => b.flights - a.flights || a.airline.localeCompare(b.airline))

    const byAircraft = [...byAircraftMap.entries()]
      .map(([name, count]) => ({ name, count, known: true }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    if (unknownAircraft) {
      byAircraft.push({ name: '', count: unknownAircraft, known: false })
    }

    const airlines = new Set(flights.map(f => normText(f.airline).toUpperCase()).filter(Boolean))
    const countries = new Set(flights.map(f => countryOf(f.arrival)).filter(Boolean))
    const aircraft = new Set(flights.map(f => normText(f.aircraft)).filter(Boolean))

    return {
      totals: {
        flights: flights.length,
        airports: byAirportMap.size,
        countries: countries.size,
        airlines: airlines.size,
        aircraft: aircraft.size,
        unknownAircraft,
        firstDate,
        lastDate,
      },
      byYear,
      byAirport,
      byCountry,
      byAirline,
      byAircraft,
    }
  }

  function shortAirportName(name) {
    if (!name) return ''
    return String(name)
      .replace(/\bInternational\b/gi, 'Intl')
      .replace(/\bAirport\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/[,\-–]\s*$/, '')
      .trim()
  }

  function flightsForIds(flights, ids) {
    const wanted = new Set(ids || [])
    return (flights || []).filter(f => wanted.has(f.id)).sort(sortByDateDesc)
  }

  return {
    FLIGHT_KEYS,
    AIRPORT_KEYS,
    normCode,
    normText,
    unique,
    makeId,
    escapeHtml,
    flightYear,
    dateInYear,
    dateValue,
    isValidDate,
    isValidFlight,
    normalizeFlight,
    normalizeAirport,
    sortByDateDesc,
    sortByDateAsc,
    serializeFlights,
    serializeAirports,
    serializeData,
    parseNdjson,
    parseImport,
    validateData,
    aggregate,
    shortAirportName,
    flightsForIds,
  }
})
