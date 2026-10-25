#!/usr/bin/env node
// Validate the canonical combined NDJSON file and aggregate definitions.
// Usage: node tools/verify-data.mjs
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const core = require('../flight-core.js')

const dataUrl = name => new URL(`../data/${name}`, import.meta.url)
const read = name => fs.readFileSync(dataUrl(name), 'utf8')

const failures = []
function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
  if (!ok) failures.push(label)
}

const flightText = read('flights.ndjson')
const flightParse = core.parseImport(flightText)
check('flight parse errors', flightParse.errors.length, 0)
check('flight records in canonical file', flightParse.flights.length, 130)
check('airport records in canonical file', flightParse.airports.length, 62)

const validated = core.validateData(flightParse.flights || [], flightParse.airports || [])
const { flights, airports, warnings } = validated

console.log('\nWarnings:')
if (!warnings.length) console.log('  (none)')
for (const warning of warnings) console.log(`  - ${warning.type}: ${warning.message}`)

const agg = core.aggregate(flights, airports)
const t = agg.totals

console.log('\nTotals:')
check('flights', t.flights, 130)
check('airports', t.airports, 62)
check('countries', t.countries, 25)
check('airlines', t.airlines, 27)
check('aircraft', t.aircraft, 22)
check('airports index rows', agg.byAirport.length, 62)
check('countries index rows', agg.byCountry.length, 25)
check('airlines index rows', agg.byAirline.length, 27)

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
check('sum airport departures', sum(agg.byAirport, 'departures'), 130)
check('sum airport arrivals', sum(agg.byAirport, 'arrivals'), 130)
check('sum airport totals', sum(agg.byAirport, 'total'), 260)
check('sum airline flights', sum(agg.byAirline, 'flights'), 130)
check('sum country arrivals', sum(agg.byCountry, 'arrivals'), 130)
check('sum aircraft counts', sum(agg.byAircraft, 'count'), 130)

check('flight ids unique', new Set(flights.map(f => f.id)).size, 130)
check('airport codes unique', new Set(airports.map(a => a.iata)).size, 62)
check('unknown airport codes', agg.byAirport.filter(a => !a.name).length, 0)
const roundTrip = core.parseImport(core.serializeData(flights, airports))
check('round-trip flights', roundTrip.flights.length, 130)
check('round-trip airports', roundTrip.airports.length, 62)

// Spot checks
const bcn = agg.byAirport.find(a => a.code === 'BCN')
check("BCN total", bcn ? bcn.total : -1, 29)
const ryanair = agg.byAirline.find(a => a.airline === 'Ryanair')
check("Ryanair flights", ryanair ? ryanair.flights : -1, 27)
const spain = agg.byCountry.find(c => c.country === 'Spain')
check("Spain arrivals", spain ? spain.arrivals : -1, 22)

// A malformed line must not destroy the rest of the file.
const broken = core.parseNdjson(flightText.split('\n')[0] + '\n{not json}\n')
check('corrupt line errors', broken.errors.length, 1)
check('corrupt line survivors', broken.items.length, 1)

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('All checks passed.')
