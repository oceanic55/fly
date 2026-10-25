# next.md — Implementation spec: file-backed storage, no auth, breakdown views

Status: **implemented** (2026-10-24)
Date: 2026-10-23
Touches: `index.html`, `app.js`, `ios.html`, `styles.css`, `data/`, docs

> Implemented, with a later simplification: the canonical data is `data/flights.ndjson`,
> containing both flight and airport records. `flight-core.js` parses/aggregates it and `flight-store.js` persists it.
> The earlier two-file design below is historical and is not the current behavior. The
> follow-up decision is one canonical file because country totals need airport metadata:
> flight records alone cannot tell the app which countries an airport belongs to.
> Supabase, GitHub auth, realtime sync and `seed-data.js` are gone.
> See `AGENTS.md` for the current architecture and `tools/verify-data.mjs` for the
> data/aggregate checks. Sections below are kept as the design record.

### Current storage decision

`data/flights.ndjson` is the only file the app loads or saves. It contains all flight
records first, followed by airport metadata records. The parser separates the two
record shapes; aggregation uses airport country values to calculate country totals.
The former `data/airports.ndjson` duplicated those airport records and has been removed.

---

## 0. Summary

1. **Remove Supabase, GitHub auth, and realtime sync entirely.**
2. **Move the dataset out of `seed-data.js` into a plain data file** under `data/`, loaded with `fetch` and saved back to disk. Current canonical format is **NDJSON** (one JSON record per line), with flights followed by airport records in `data/flights.ndjson`.
3. **Keep `localStorage` as an automatic unsaved-draft buffer**, so edits survive a closed tab, but the files are the source of truth.
4. **Always show Import** in both entrypoints (the iOS button is currently hidden by auth gating).
5. **Add Airports, Countries, and Airlines views** with totals, each drilling down into a date-ordered flight breakdown.
6. Fix the stats inconsistencies, add validation, and share the parsing/aggregation logic between the two pages.

The one hard browser constraint: **a static page cannot silently overwrite files in the project folder.** It can only `fetch` them. "Save" therefore means either (a) download the file for the user to put back into `data/`, or (b) use the File System Access API on desktop Chromium after the user links the `data/` folder once. The spec implements both, with download as the universal fallback. See §4.

---

## 1. Audit of the current app

### 1.1 Architecture as it exists

| Concern | Desktop (`index.html` + `app.js`) | Mobile (`ios.html`, inline JS) |
|---|---|---|
| State | `localStorage['flights-db-v1']` | same key |
| Remote read/write | Supabase `flights` / `airports` tables (full-array upsert) | same |
| Auth | GitHub OAuth via Supabase Auth | same |
| Realtime | `postgres_changes` subscription on `flights` | same |
| Dataset | `window.SEED_DATA` (`seed-data.js`) | same |
| Airport metadata | Wikidata SPARQL on unknown code, then `prompt()` | same |
| Views | Dashboard (year list + year detail), Data entry (form + all-flights table) | Flights (year pills + cards), Data Entry (search + cards + bottom-sheet form) |
| Import/Export | JSON `{flights, airports}`; Import hidden unless signed in | same shape; **Import also hidden unless signed in** |

Boot sequence (both): `initAuth()` → `loadInitialData()` (Supabase → localStorage → seed) → `subscribeRealtime()` → `wireEvents()` → `renderAll()`. All writes go to localStorage first, then to Supabase only if a session exists.

### 1.2 Current data

- `seed-data.js`: **130 flights**, **62 airports**, all 62 airports used.
- Derived from arrival countries: **25 countries**, **27 airlines**, **22 known aircraft types**.
- **96 of 130 flights have no aircraft** recorded.
- No duplicate flight IDs and no unknown airport codes.
- Two records are out of chronological order (`f85`, `f39`); one date is a typo: **`f39` = `2105-11-04`** (almost certainly 2015).
- `data/flights.json` and `data/airports.json` are stale duplicates of the seed; `airport-db.json` duplicates the seed's airport records and is not consumed.

### 1.3 Problems relevant to this work

| # | Problem | Effect |
|---|---|---|
| A1 | Supabase is the only cross-device store, but it is a shared global dataset with no per-user data. Overkill for a personal log, and it depends on CDN + network + RLS config. | Fragile; the app looks device-dependent when RLS/grants break. |
| A2 | Auth gates **Import** in `applyAuthUI()` (`importLabel` toggled hidden when signed out), even on iOS. | The user cannot import on iOS. |
| A3 | Auth also owns the only "signed in" UI state; removing it requires deleting two functions and the boot chain, not just a button. | See §8. |
| A4 | Import does `JSON.parse` with no `try/catch` and replaces everything unconditionally. | One malformed file silently wipes/blanks the log. |
| A5 | No schema validation; `flights` and `airports` are accepted as-is. | Bad dates/codes propagate into stats. |
| A6 | Stats definitions differ between the two pages and are internally inconsistent: desktop's "Total planes taken" only counts flights with a known arrival country; "Airports" counts departure + arrival codes; "Countries" counts arrivals only. iOS labels the same number "Flights". | Totals do not reconcile. |
| A7 | Logic is duplicated in `app.js` and `ios.html`, with different sort orders (iOS desc, desktop seed order) and different airport-name formatting. | Porting changes is error-prone. |
| A8 | New IDs use `f${Date.now()}`. | Collision possible on rapid adds. |
| A9 | Supabase URL + anon key are hardcoded in both files. | Keys are in git history forever (anon keys are public by design, but the project should be deleted/rotated if it is going away). |
| A10 | No file round-trip: edits only ever live in a browser profile until manually exported. | Losing the browser profile loses edits. |

### 1.4 What is worth keeping

- No build step; static files; simple serving.
- The overall visual language and the two purpose-built layouts.
- Year drilldown, flight detail card, bottom-sheet editor, airport lookup via Wikidata.
- Import/export of a full backup.
- Local-first writes (they become the *only* writes).

---

## 2. Goals / non-goals

### Goals

- File-backed dataset with explicit load/save, no remote service, no login.
- Reliable draft persistence so nothing is lost before a save.
- Import always available in both pages; robust parsing with errors surfaced.
- Three new aggregate views with totals and drilldowns, consistent between pages.
- Shared, tested aggregation logic; one definition of every total.
- Clean removal of Supabase code, CSS, docs, and scripts.

### Non-goals

- A backend API or automatic server-side file writes.
- Multi-user sync, accounts, permissions.
- PWA service worker/offline install work (draft buffer only).
- A full airport metadata editor (unknown airports still use lookup + prompt, as today).
- Visual redesign beyond the new panels/nav.
- Migrating to Firebase (see `Documents/fire.md`, now obsolete).

---

## 3. File format decision

### 3.1 The question

> Is `seed-data.js` the best format for data that will be edited constantly?

**No.** It is JavaScript, not data: it loads via `<script>`, cannot be fetched/parsed safely, diffs as one enormous line, and one syntax error removes the whole dataset. It also mixes code and content.

### 3.2 Recommendation: NDJSON, one record per line

Canonical files:

```text
data/flights.ndjson     ← edited constantly
data/airports.ndjson    ← small reference table, rarely edited
```

`flights.ndjson` sample (one compact object per line, fixed key order):

```json
{"id":"f1","date":"2012-12-03","departure":"AMS","arrival":"PHL","airline":"US AIRWAYS","aircraft":""}
{"id":"f2","date":"2012-12-03","departure":"PHL","arrival":"SEA","airline":"US AIRWAYS","aircraft":""}
```

`airports.ndjson` sample:

```json
{"iata":"AMS","name":"Amsterdam Airport Schiphol","city":"Amsterdam","country":"Netherlands"}
```

Why NDJSON for this dataset:

| Criterion | NDJSON | JSON array | CSV | YAML |
|---|---|---|---|---|
| Git diff per edited flight | **one line** | record + surrounding commas | one line | record block |
| One malformed record | **only that line lost** | whole file unparseable | usually local | often whole file |
| Append a flight | **append one line** | insert object + comma | append one row | insert block |
| Hand-editable | **yes** | okay | yes (best for spreadsheets) | yes, but indentation-sensitive |
| Needs a library/dependency | **no** | no | small parser | CDN parser |
| Preserves types / future nesting | **yes** | yes | no | yes |
| Spreadsheet-friendly | no | no | **yes** | no |

CSV is the only serious alternative, and it wins if the flights are regularly edited in Numbers/Excel. It loses on quoting (airport names contain commas), type fidelity, and future fields. The app can still **export CSV** later as a read-only convenience; NDJSON stays canonical.

YAML is rejected because it needs a parser dependency and is easy to break by hand. A pretty-printed JSON array is acceptable but produces noisy diffs and is all-or-nothing on parse errors.

### 3.3 Conventions

- UTF-8, LF line endings, **one compact JSON object per line**, trailing newline.
- No blank lines, no comments, no pretty-printing within a line.
- Fixed key order:
  - flight: `id`, `date`, `departure`, `arrival`, `airline`, `aircraft`
  - airport: `iata`, `name`, `city`, `country`
- Dates are ISO `YYYY-MM-DD`; IATA codes uppercase; airline/aircraft preserved as entered (trimmed).
- IDs are stable and never reused. New flights use `f-<uuid>` when `crypto.randomUUID()` exists, otherwise `f${Date.now()}${Math.random().toString(36).slice(2,7)}`.
- Blank lines are skipped. A malformed line is reported by line number and skipped; the rest of the file loads.
- Unknown flights keep their IATA code; a stub airport (`{iata, name:"", city:"", country:""}`) is synthesized in memory and written on the next save.

### 3.4 Why two files, and where

Splitting flights (log data) from airports (reference data) keeps diffs focused and lets the app save airports only when they changed. `data/` already exists in the repo and is the natural home. The old `data/flights.json`, `data/airports.json`, and `airport-db.json` become redundant; move them to `data/archive/` (or delete them) after verifying the new files match.

`seed-data.js` is deleted once the NDJSON files are generated. There is no script-tag fallback any more; the app must be served over HTTP(S) (already the documented workflow). If both fetch and the draft are unavailable, the app starts empty with an Import prompt.

### 3.5 Import compatibility

Accept all of these, auto-detected by content:

1. NDJSON (one object per line) — flights and/or airports.
2. JSON array of flight objects (has `departure`/`arrival`).
3. JSON array of airport objects (has `iata`).
4. Legacy combined JSON `{ "flights": [...], "airports": [...] }` (current Export format).
5. A single JSON object with those keys, pretty-printed or not.

Export continues to offer the combined `flights-backup.json` for backup/portability. Canonical Save writes the two NDJSON files.

---

## 4. Persistence model (static-page reality)

### 4.1 Options

| Option | Can it update `data/*.ndjson` in the repo? | Works on iOS/Safari | Complexity |
|---|---|---|---|
| A. Load by `fetch`, Save by **download** | No — user moves the file | Yes | Lowest |
| B. **File System Access API** (`showDirectoryPicker`) | **Yes**, after one folder-link gesture, Chromium only | No | Medium |
| C. Tiny local server with `PUT` endpoint | Yes, automatic | Yes | Highest (needs a process + server code) |

### 4.2 Chosen model: A + B layered

1. **Load**: `fetch('data/flights.ndjson')` and `fetch('data/airports.ndjson')` with `cache: 'no-store'`.
2. **Draft**: every mutation writes to `localStorage['flights-db-v2']` immediately (debounced ~150 ms). The draft is a safety net, not the source of truth.
3. **Save**:
   - If the `data/` folder was linked via File System Access API (desktop Chromium), write both dirty files in place, show "Saved to data/", clear dirty.
   - Otherwise generate downloads: `flights.ndjson` always when dirty; `airports.ndjson` only when airport metadata changed. Show "Downloaded flights.ndjson — replace the file in data/".
4. **Import / Export backup** stay available for moving data between devices and for restoring.
5. A local write endpoint (option C) is explicitly out of scope; documented as the only way to get silent autosave on iOS.

### 4.3 Startup state machine

| Fetch files | Draft exists | Behaviour |
|---|---|---|
| OK | No | Use files; clean. |
| OK | Yes, hash matches files | Use files; clean. |
| OK | Yes, hash differs | Use **files**; banner: "Local draft found (N flights, M changes) — Restore / Discard". Never silently overwrite either side. |
| Missing | Yes | Use draft silently; no banner — a missing data file is a normal first run. |
| Missing | No | Empty dataset; no banner; empty states point at Data entry and Import. |
| One file OK, one missing | — | Use what loaded; synthesize missing airport stubs; no banner. |
| File present but unreadable | — | Warn banner with the first parse error; the readable lines still load. |

Hash: small synchronous FNV-1a over the serialized content, stored in the draft; used only to detect drift, not security.

Draft shape:

```js
{
  schemaVersion: 2,
  flights: [...],
  airports: [...],
  savedAt: "2026-10-23T14:02:11.000Z",
  fileHash: "8a3f19c2",
  dirty: true,
  source: "files" | "import" | "migration"
}
```

One-time migration from `flights-db-v1`: if v1 exists and v2 does not, load v1 into the draft with `dirty: true` and `source: "migration"`, and show "Existing local data imported — review and save". Do not delete v1 until the first successful save.

### 4.4 Save semantics

- Save button (header, both pages) and `Cmd/Ctrl+S`.
- Dirty indicator in the status banner and a dot on the Save button.
- `beforeunload` warning when `dirty === true`.
- After a download, mark clean but keep a warning banner until the next load ("Downloaded — move it into data/ to publish"). The app cannot verify the move.
- After an in-place folder save, clear the warning and show "Saved to data/".
- Save never mutates the in-memory dataset.

### 4.5 File System Access details (optional enhancement)

- "Link data folder" button; `showDirectoryPicker({ id: 'flight-data', mode: 'readwrite' })`; require the directory to contain (or create) `flights.ndjson` / `airports.ndjson`.
- Persist the `FileSystemDirectoryHandle` in IndexedDB; on load call `queryPermission({mode:'readwrite'})` and only auto-write when already granted, otherwise request on Save.
- Only shown when `window.showDirectoryPicker` exists (Chromium desktop). Hidden elsewhere; iOS uses downloads.
- Secure context required: `http://localhost` is fine, plain `http://<LAN-IP>` is not.

---

## 5. Data model and definitions

### 5.1 Records

```ts
type Flight = {
  id: string
  date: string          // YYYY-MM-DD (may be empty/invalid in legacy data)
  departure: string     // IATA, uppercase
  arrival: string       // IATA, uppercase
  airline: string       // trimmed, may be empty
  aircraft: string      // trimmed, may be empty
}

type Airport = {
  iata: string
  name: string
  city: string
  country: string
}
```

Validation (warnings, never destructive):
- `date` must match `^\d{4}-\d{2}-\d{2}$` and be a real date; otherwise exclude from year grouping but keep the flight.
- `departure`/`arrival` non-empty and `^[A-Z0-9]{3,4}$`.
- Duplicate flight `id` → keep first, warn with line number.
- Airport duplicate `iata` → keep last, warn.
- Unknown code → synthesize blank airport stub; do not block saving.
- Flag year < 2000 or > current year + 1 (catches `2105`).

### 5.2 Canonical totals

All pages and views import these from `FlightCore.aggregate()`. No view computes its own totals.

| Metric | Definition |
|---|---|
| **Flights** | Count of valid flights (at least one of date/departure/arrival/airline/aircraft set). |
| **Airports** | Distinct normalized codes across departures **and** arrivals. |
| **Countries** | Distinct non-empty countries of **arrival** airports. (Matches the current "countries visited" meaning.) |
| **Airlines** | Distinct non-empty airlines, compared case-insensitively; display the first-seen spelling. |
| **Aircraft** | Distinct non-empty aircraft types. |
| **Airport departures** | Flights whose `departure` is that code. |
| **Airport arrivals** | Flights whose `arrival` is that code. |
| **Airport total** | departures + arrivals. |
| **Airport first/last** | Earliest/latest flight date involving the airport. |
| **Country airports** | Distinct airports of that country used by at least one flight. |
| **Country arrivals** | Flights arriving at any airport in that country (the headline number). |
| **Country departures** | Flights departing from any airport in that country (secondary column). |
| **Country first/last** | Earliest/latest flight touching the country (either direction). |
| **Airline flights** | Flights with that airline. |
| **Airline airports** | Distinct departure + arrival codes on those flights. |
| **Airline countries** | Distinct arrival countries on those flights. |
| **Airline aircraft** | Distinct non-empty aircraft on those flights. |

Consistency checks for tests:
- `sum(airline.flights) === total flights with a non-empty airline`.
- `sum(airport.departures) === total flights with a departure`.
- `sum(airport.arrivals) === total flights with an arrival`.
- `sum(country.arrivals) === total flights with a known arrival country`.
- **Fix**: the header "Flights" count no longer depends on a known arrival country (desktop currently drops unknown-country flights from that number).

### 5.3 Sort orders (unified)

- Years: newest first (change desktop from ascending).
- Airports index: total desc, then code asc. Alternate sorts: A–Z, last visit desc.
- Countries index: arrivals desc, then country asc.
- Airlines index: flights desc, then name asc.
- Any flight breakdown: `date` desc, then `id` desc. Invalid dates sort last.
- Detail tables group by year (year subheading) when there are more than 20 rows.

---

## 6. Shared modules (new)

To stop the two entrypoints drifting, add two classic scripts (no build step), loaded before the page script in **both** pages:

```html
<script src="flight-core.js"></script>
<script src="flight-store.js"></script>
```

### 6.1 `flight-core.js` → `window.FlightCore`

Pure functions only; no DOM, no storage.

| Function | Purpose |
|---|---|
| `parseNdjson(text)` | `{ items, errors:[{line, message, raw}] }`; skips blanks. |
| `parseImport(text)` | Auto-detect NDJSON / array / combined object. `{ flights?, airports?, format, errors }`. |
| `serializeFlights(flights)` / `serializeAirports(airports)` | NDJSON with fixed key order + trailing newline. |
| `normalizeFlight(f)` / `normalizeAirport(a)` | Trim, uppercase codes, coerce to strings. |
| `validateData(flights, airports)` | `{ flights, airports, warnings }`; dedupes, validates, synthesizes unknown airport stubs. |
| `aggregate(flights, airports)` | The single source of truth for §5.2. Returns `{ totals, byYear, byAirport, byCountry, byAirline, byAircraft }`. |
| `shortAirportName(name)` | Current "International → Intl / Airport → ''" helper. |
| `flightYear(f)` / `sortByDateDesc(a,b)` | Shared helpers. |

`aggregate()` returns arrays (not `Map`s) ready to render, e.g.:

```js
byAirport: [{
  code: 'BCN', name: '...', city: 'Barcelona', country: 'Spain',
  departures: 12, arrivals: 14, total: 26,
  first: '2013-06-10', last: '2022-11-24', flightIds: [...]
}]
```

### 6.2 `flight-store.js` → `window.FlightStore`

| Function | Purpose |
|---|---|
| `loadFiles(urls)` | `fetch` both files; `{ flights, airports, errors, ok }`; HTTP errors distinguished from parse errors. |
| `readDraft()` / `writeDraft(state)` / `clearDraft()` | `flights-db-v2` wrapper with schema/version checks. |
| `migrateV1()` | Copy `flights-db-v1` into a v2 draft once. |
| `hash(text)` | FNV-1a drift check. |
| `download(filename, text)` | Blob + anchor download. |
| `supportsFolder()` / `linkFolder()` / `saveToFolder(files)` | File System Access API; IndexedDB handle persistence. |
| `dirtyFiles(state)` | Which of flights/airports need writing. |

Unit-testable without a browser: `FlightCore` is pure; a small `tools/verify-data.mjs` script can import it in Node to validate files and print aggregate checks (optional but recommended).

---

## 7. UI specification

### 7.1 Header (both pages)

Desktop (`index.html`):

```text
[✈ FLY] [Import] [Save] [Export backup]              [stat chips…]
```

- Remove `#authBar`, `#authStatus`, `#signInBtn`, `#signOutBtn`.
- **Import is always visible**; remove the auth toggle.
- New `Save` button (`#saveData`).
- `Export backup` keeps the combined JSON export.
- Import input: `accept=".json,.ndjson,.txt,application/json,application/x-ndjson"`.

iOS (`ios.html`): `[✈ FLY] [Import] [Save]` — same, compact. Never hide Import.

### 7.2 Status banner

Rename `#syncStatus` → `#fileStatus` (class `file-status`, states `ok | warn | error`). Messages:

| State | Text |
|---|---|
| Loaded | `Loaded data/flights.ndjson · 130 flights` |
| Unsaved | `Unsaved changes · 3 edits` (warn) |
| Downloaded | `Downloaded flights.ndjson — replace it in data/` (warn) |
| Folder save | `Saved to data/` (ok) |
| Nothing on disk / unreadable draft | *silent* — empty page or cached draft, no error |
| Partial read | `Loaded 130 flights · flights.ndjson line 17: <parse error>` (warn) |
| Parse issues | `flights.ndjson: 2 lines skipped (line 17, line 88)` (warn) |
| Import | `Imported 131 flights and 62 airports` (ok) |

The old "Signed out / Synced / Sync failed" strings disappear.

### 7.3 Navigation

**Desktop tabs:** `Flights` (existing dashboard; rename label from "Dashboard") · `Airports` · `Countries` · `Airlines` · `Data entry`.

**iOS bottom nav (5 items):** `Flights` · `Airports` · `Countries` · `Airlines` · `Data entry`.
The 5 labels fit at the current 10px size; if not, shorten to `Flights / Airports / Countries / Airlines / Entry` (still accessible names via `aria-label`).

Stat chips become **buttons** that switch to the corresponding view (Airports, Countries, Airlines); Flights/Aircraft chips go to Flights / stay informational.

### 7.4 Airports view

**Index (desktop two-column: list left, detail right; iOS: list screen):**

| Column | Content |
|---|---|
| Airport | `AMS` + short airport name |
| City | city |
| Country | country |
| Departures | count |
| Arrivals | count |
| Total | count (bold) |
| Last | latest date |

Header line: `62 airports · 130 flights` plus a search field (code/name/city/country) and sort selector (`Most used` default · `A–Z` · `Last visit`).

Clicking a row/card shows the **breakdown**:

```text
← Airports
AMS · Amsterdam Airport Schiphol
Amsterdam, Netherlands · 14 flights · 7 departures · 7 arrivals · 2012-12-03 → 2026-01-01
[By year: 2026 (1) · 2024 (2) · …]
Date        Direction  Route        Airline          Aircraft
2026-01-01  ← Arrival  FRA → AMS    Lufthansa        Airbus A321neo
...
```

- Rows sorted date desc, grouped by year.
- Each row shows the opposite airport's city/country and opens the existing flight-detail card inline (back returns to the airport breakdown).
- Empty state: `No flights recorded for this airport.`

This satisfies "list all airports by date" both ways: the index can be sorted by last visit, and the breakdown is a date-ordered flight list.

### 7.5 Countries view

**Index columns:** Country · Airports (count) · Arrivals · Departures · Total · First · Last. Search filters by country or member airport code/name. Sorted by arrivals desc.

**Breakdown:**

```text
← Countries
Spain
26 flights · 8 airports · 2013-06-10 → 2024-12-05
Airports: BCN (26) · AGP (1) · MAD (1) · TFS (1) · VLC (12) …
Date        Route        Airport        Airline       Aircraft
2013-06-10  ATH → BCN    Barcelona      Vueling       —
...
```

- Countries are arrival-country based for the headline; the breakdown includes flights arriving in the country (primary) and notes departures in the summary chips.
- Clicking an airport chip jumps to that airport's breakdown (optional but cheap).

### 7.6 Airlines view

**Index columns:** Airline · Flights · Airports · Countries · Aircraft · First · Last. Sorted by flights desc.

**Breakdown:**

```text
← Airlines
Ryanair
31 flights · 22 airports · 9 countries · 3 aircraft · 2013-06-12 → 2019-10-25
Aircraft: Boeing 737-800 (12) · — (19)
Date        Route        Airline   Aircraft
...
```

- Rows date desc; grouping by year.
- Aircraft sub-list counts types, with an "Unknown" bucket for blank aircraft.

### 7.7 Import / export flows

- **Import** opens the file picker, reads text, `FlightCore.parseImport`.
- If the file has only flights or only airports, ask before merging/replacing that half.
- Always show a confirm: `Replace 130 flights and 62 airports with 131 flights and 62 airports?` (include current/imported counts).
- Before replacing, snapshot current state to `flights-db-v2.undo`; offer `Undo import` in the banner for one step.
- On parse errors, keep valid records, show warnings, never silently discard.
- After import, mark dirty; do not auto-save until the user clicks Save.
- **Export backup** downloads `flights-backup.json` (`{flights, airports}`, pretty-printed) — suitable for git/off-device backup and for re-import.

### 7.8 Editor behaviour

- Add/edit/delete continue to work exactly as now, against in-memory state + draft.
- On submit with an unknown airport, keep the Wikidata lookup; on failure, prompt for country/city/name as today. If skipped, add a blank stub airport so the code appears in views.
- New IDs use the collision-resistant scheme in §3.3.
- After add/edit/delete: write draft, mark dirty, re-render all active views (aggregates change).
- Deleting a flight does not delete an airport record (airports are reference data), so airport totals naturally show 0-use records only if explicitly imported; the index filters to airports with ≥1 flight.

### 7.9 Accessibility / responsive

- Rows/cards that navigate are real `<button>`s or have `role="button"`, `tabindex="0"`, Enter/Space handling.
- Back buttons are labeled `← Airports`, etc.
- Stat chips are buttons with accessible labels (`Airports: 62`).
- Desktop: below 900px the index/detail stack (detail replaces index or sits below with a back button). iOS: one screen at a time.
- Keep the current focus styles; add `:focus-visible` outlines to clickable table rows.

---

## 8. Removal checklist (Supabase / auth / realtime)

### `app.js`

- Delete Supabase config, `createClient`, `window._sb` (lines 1–10).
- Delete `_ownerSession`.
- Delete `initAuth`, `applyAuthUI`, `subscribeRealtime`.
- `save()`: remove remote upsert branch and "Signed out" status; persist draft + return.
- `deleteFlight()`: remove remote delete branch; just filter + draft.
- Delete the hidden/unhidden logic for `importLabel`.
- Boot: `loadDataFiles() → wireEvents() → renderAll()`; no auth chain.

### `index.html`

- Remove the Supabase CDN `<script>`.
- Remove `#authBar` block (`#authStatus`, `#signInBtn`, `#signOutBtn`).
- Keep `#importLabel` visible; update `accept`.
- Add `#saveData`; add the new tab buttons and panels.
- Load `flight-core.js` and `flight-store.js`.

### `ios.html`

- Remove the Supabase CDN `<script>`, config, `sb`, `_session`, `initAuth`, `applyAuthUI`, `subscribeRealtime`.
- Remove all `_session` branches in `loadData`, `saveData`, `deleteFlightById`.
- Remove `#authStatus`, `#signInBtn`, `#signOutBtn` markup + CSS.
- **Delete `$('importLabel').classList.toggle('hidden', !ok)`** — this is the iOS import bug.
- Add `#saveData`; add the new nav buttons/panels; update `accept`.
- Load the two shared scripts before the inline app script.
- Boot without auth.

### `styles.css`

- Delete `#authBar`, `#authStatus`, `.auth-btn` rules.
- Rename `.sync-status` → `.file-status` (keep ok/warn/error variants).
- Add styles: aggregate tables, index rows, count badges, detail header, back button, year group headings, chip buttons (desktop stat chips become interactive).
- Keep the `.hidden` utility.

### Docs / data

- `AGENTS.md`: rewrite the architecture table (no Supabase/auth/realtime; file storage + draft + optional folder save), data locations, how to edit data files, how to run, and the new views.
- `Documents/flyfix.md` (Supabase fix) and `Documents/fire.md` (Firebase migration) are obsolete → move to `Documents/archive/` or delete.
- `data/flights.json`, `data/airports.json`, `airport-db.json` → `data/archive/` after equivalence check, or delete.
- `seed-data.js` → delete after generating the NDJSON files and verifying counts.
- Note for the user: removing the Supabase key from files does not remove it from git history; delete/rotate the Supabase project if it is truly retired.

---

## 9. Migration (one-time)

1. **Back up the current dataset.**
   - Open the app while still on the old version and click **Export** → save `flights-backup.json`.
   - If Supabase may hold newer data than the seed, run in the console: `await window._sb.from('flights').select('*')` / `...('airports').select('*')` and export the results. Use the newest trusted set as canonical.
2. **Generate `data/flights.ndjson` and `data/airports.ndjson`** from the chosen export:
   - normalize fields, sort by date asc then id (file order is not semantically important, but stable),
   - one compact record per line, fixed key order, trailing newline.
   - Expected baseline: 130 flights, 62 airports.
3. **Verify** with the optional Node check (`tools/verify-data.mjs` or a one-off command): counts, unique IDs, unknown codes, aggregate reconciliation (§5.2), and the `f39` date warning.
4. **Implement the code changes** (both entrypoints) and test locally.
5. **Delete `seed-data.js`** and archive the old snapshots once both pages load from NDJSON.
6. **Update docs** and commit.
7. **Optional cleanup:** decommission the Supabase project after confirming no code references it.

Rollback: restore the pre-change commit and the exported JSON; nothing in the new version depends on Supabase.

---

## 10. Acceptance criteria

### Storage / no auth

- [ ] No request to `supabase.co` anywhere; no Supabase script tag or key in the repo.
- [ ] No Sign in / Sign out UI in either page.
- [ ] Both pages load 130 flights from `data/flights.ndjson` when served with `python3 -m http.server 8000`.
- [ ] Add/edit/delete updates the UI and the draft immediately; reload keeps the draft.
- [ ] Save downloads `flights.ndjson` (and `airports.ndjson` when airport data changed); replacing the files and reloading shows the edits.
- [ ] On Chromium desktop, linking `data/` writes the files in place; on Safari/iOS, the download fallback is used and explained in the banner.
- [ ] `beforeunload` warns when there are unsaved changes.
- [ ] Corrupt one line of `flights.ndjson`: the app loads the remaining lines and reports the line number; saving does not reintroduce the corrupt line.
- [ ] Importing a legacy `{flights, airports}` export works; Import is visible on iOS without any session.
- [ ] Importing an invalid file shows an error and does not wipe existing data.
- [ ] The old `flights-db-v1` cache is migrated once and offered on first load.

### New views (both pages)

- [ ] Airports index shows 62 rows; totals reconcile (departures + arrivals = 2 × 130 = 260; airport total sum = 260).
- [ ] Countries index shows 25 rows (arrival countries); `sum(arrivals) = 130`.
- [ ] Airlines index shows 27 rows; `sum(flights) = 130` (all flights have an airline in current data).
- [ ] Aircraft = 22 known types; unknown/blank shown as "—" or an "Unknown" bucket.
- [ ] Clicking an airport/country/airline shows only its flights, sorted by date desc, grouped by year.
- [ ] Back returns to the index with the previous search/sort intact.
- [ ] Stat chips navigate to the corresponding view.
- [ ] Desktop and iOS show the same totals for the same data.
- [ ] Empty dataset shows helpful empty states, not broken tables.

### Quality

- [ ] No duplicated aggregation logic between `app.js` and `ios.html`; both call `FlightCore.aggregate()`.
- [ ] `FlightCore` has no DOM/storage dependencies and can be exercised in Node.
- [ ] No console errors during normal use.
- [ ] Keyboard navigation works for tabs, index rows, back buttons, and stat chips.

---

## 11. Decisions to confirm before/while implementing

| # | Decision | Recommendation |
|---|---|---|
| D1 | Format: NDJSON vs pretty JSON vs CSV | **NDJSON**, two files; JSON/legacy import supported. CSV export can be added later. |
| D2 | Save mechanism | **Download everywhere + optional folder linking on Chromium.** A true silent save on iOS requires a local write server (out of scope). |
| D3 | Country totals | **Arrival-only** for "countries visited" (matches current logic); show departures as a secondary number. |
| D4 | iOS nav | **5 bottom-nav items**; shorten labels if they crowd. |
| D5 | `f39` date `2105-11-04` | Fix to `2015-11-04` in the generated data file; keep a warning in validation for future typos. |
| D6 | Keep `seed-data.js` as fallback | **No**; files + draft + import cover recovery. |
| D7 | Archive vs delete old JSON snapshots | Archive under `data/archive/` for one release, then delete. |
| D8 | Editing airports | Keep the current lookup + prompt flow; no dedicated metadata editor in this pass. |

---

## 12. Implementation order

1. `flight-core.js` (parser, validation, aggregation) + `tools/verify-data.mjs`; verify against the current seed.
2. Generate `data/flights.ndjson` / `data/airports.ndjson`; run the verifier.
3. `flight-store.js` (fetch, draft, hash, download, optional folder linking).
4. Desktop: remove Supabase/auth/realtime; wire load/draft/save; fix Import; status banner.
5. Desktop: add Airports / Countries / Airlines panels and drilldowns; shared table/card renderers.
6. iOS: same removal + storage + views + always-visible Import.
7. Import/export hardening, undo, beforeunload, empty/error states.
8. Delete `seed-data.js`, archive redundant data files, update `AGENTS.md` and docs.
9. Manual QA against §10 on desktop Chrome/Safari and iOS Safari (or responsive mode), including a real file round-trip.

---

## 13. Out of scope / follow-ups

- A CSV import/export for spreadsheet editing.
- A dedicated airport/country metadata editor.
- A local Node/Python write server for silent autosave on iOS.
- Cross-device sync (if it ever returns, it should be opt-in and not a prerequisite for local editing).
- PWA service worker / offline app shell.
- A "Map" or route-geometry view.
