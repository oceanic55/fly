# FLYFIX — Shared-data fix implementation spec

## 1. Problem

Any user who opens the page is expected to see the same saved flight/airport data
(shared, global dataset). Today the app behaves device/browser-dependent:

- User A adds a flight on their browser → user B on another browser never sees it.
- Data appears to "save" but never reaches the server.

## 2. Root cause (verified)

1. **Server-side:** The `anon` role has no privileges on `public.flights` /
   `public.airports`. Verified via REST API:
   ```
   GET /rest/v1/flights?select=* → 404 "Could not find the table 'public.flights' in the schema cache"
   GET /rest/v1/airports?select=* → 404 (same)
   ```
   PostgREST hides tables from the schema cache when the requesting role lacks
   privileges. So every read falls through to the offline/localStorage path.
2. **Client-side masking:** `loadInitialData()`/`loadData()` swallow the remote
   error and silently fall back to `localStorage` → seed. `save()`/`saveData()`
   only `console.error` on failure while the UI still shows success. The user
   therefore believes their entry synced when it did not.

The design intent is correct (single global dataset, no `user_id` scoping); the
transport + RLS config is what breaks sharing.

## 3. Fix overview

| # | Change | Where |
|---|--------|-------|
| 1 | Grant roles + RLS policies for a global shared dataset | Supabase SQL (manual, server-side) |
| 2 | Surface sync status/errors to the user instead of silent failure | `app.js`, `ios.html` |
| 3 | Add a sync-status banner element + styling | `index.html`, `ios.html`, `styles.css` |
| 4 | Seed the server with current data after policies are fixed | Manual one-time step |
| 5 | Document the RLS requirement | `AGENTS.md` |

## 4. Server-side fix (manual — Supabase SQL editor)

Run once in the Supabase project SQL editor
(`https://supabase.com/dashboard/project/sswwadgaygrbadqcgyxq/sql`).

### 4.1 Ensure tables exist (idempotent)

```sql
create table if not exists public.flights (
  id        text primary key,
  date      text,
  departure text,
  arrival   text,
  airline   text,
  aircraft  text
);

create table if not exists public.airports (
  iata    text primary key,
  name    text,
  city    text,
  country text
);
```

### 4.2 Grants

```sql
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.flights  to anon, authenticated;
grant select, insert, update, delete on public.airports to anon, authenticated;
```

### 4.3 Global RLS policies (any user reads/writes ALL rows)

```sql
alter table public.flights  enable row level security;
alter table public.airports enable row level security;

create policy "flights_read"   on public.flights  for select  using (true);
create policy "flights_insert"  on public.flights  for insert  with check (true);
create policy "flights_update" on public.flights  for update  using (true) with check (true);
create policy "flights_delete" on public.flights  for delete  using (true);

create policy "airports_read"   on public.airports  for select  using (true);
create policy "airports_insert"  on public.airports  for insert  with check (true);
create policy "airports_update" on public.airports  for update  using (true) with check (true);
create policy "airports_delete" on public.airports  for delete  using (true);
```

Notes:
- The app loads data before/without auth (anon), so `anon` needs `select`
  (and we grant writes too so the "local writes" path can sync once signed in —
  see 5.1 for the gate).
- No per-user scoping: this is a deliberately shared dataset.

## 5. Client-side changes

Both entrypoints are independent implementations and must be kept in sync.

### 5.1 Shared behavior (port to both `app.js` and `ios.html`)

1. **Add a `_syncState`-style status helper** that writes to a `#syncStatus`
   banner and toggles an `error` class + visibility:

   ```js
   function setSyncStatus(message, isError) {
     const el = $('syncStatus')
     if (!el) return
     el.textContent = message
     el.classList.toggle('error', !!isError)
     el.classList.toggle('show', !!message)
   }
   ```

2. **`loadInitialData()` / `loadData()`** — when the remote read fails, report it
   instead of failing silently:

   ```js
   if (_ownerSession) {
     const msg = (fe || ae || {}).message
     setSyncStatus(`Server read failed: ${msg || 'unknown error'} — showing local data`, true)
   }
   ```
   and in the `catch` block: `setSyncStatus('Server unavailable — showing local data', true)`.

3. **`save()` / `saveData()`** — return `true`/`false` and surface failures:

   ```js
   async function save() {
     localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))
     if (!_ownerSession) {
       setSyncStatus('Signed out — changes saved on this device only', true)
       return false
     }
     const [{ error: fe }, { error: ae }] = await Promise.all([...])
     if (fe || ae) {
       const msg = (fe || ae).message
       console.error('Supabase sync error:', msg)
       setSyncStatus(`Sync failed: ${msg} — saved on this device only`, true)
       return false
     }
     setSyncStatus('Synced')
     return true
   }
   ```

4. **`deleteFlight()` / `deleteFlightById()`** — surface remote delete errors:

   ```js
   if (error) {
     console.error('Supabase delete error:', error.message)
     setSyncStatus(`Delete failed to sync: ${error.message}`, true)
   }
   ```

5. **Realtime re-fetch** (`subscribeRealtime` in both files) already re-selects
   `flights` on any change and should keep the "Synced" banner accurate — leave
   as-is, optionally call `setSyncStatus('Synced')` on a successful re-fetch.

6. On successful remote load, clear the banner: `setSyncStatus('Synced')`.

### 5.2 `index.html` — banner element

Add after the `header-stats` section (before `<nav class="tabs">`):

```html
<div id="syncStatus" class="sync-status hidden" role="status" aria-live="polite"></div>
```

Use `hidden` ↔ `show` class toggling via the helper.

### 5.3 `ios.html` — banner element + same inline JS

- Add `<div id="syncStatus" class="sync-status hidden" role="status"></div>`
  directly under `<div id="statCards"></div>`.
- Port the `setSyncStatus`, `loadData`, `saveData`, `deleteFlightById`, and
  realtime banner updates (same logic as `app.js`, matching the inline naming:
  `$`, `_session`, `STORE_KEY`, `esc`).

### 5.4 `styles.css` — banner styling (match existing theme vars)

```css
.sync-status {
  padding: 6px 12px;
  font-size: 12px;
  background: var(--panel-2, #32466b);
  color: var(--muted, #b2bfd1);
  border-bottom: 1px solid var(--line, #4a5c79);
}
.sync-status.error { background: #4a2b2b; color: #f0b9b9; }
.sync-status.show { display: block; }
```

`ios.html` has its own inline `<style>` — port the same rules there (it already
defines `--panel-2`, `--muted`, `--line`).

## 6. Data migration (manual, one-time)

After the SQL in §4 is applied, push the current seed data to the server so fresh
browsers see the full dataset. Either:

- Use the import button (`Import`) with an export, or
- Open `index.html`, sign in, and run in the browser console:
  ```js
  await window._sb.from('flights').upsert(window.SEED_DATA.flights)
  await window._sb.from('airports').upsert(window.SEED_DATA.airports)
  ```

## 7. Verification

1. **Fresh browser, signed in:** sign in via GitHub, confirm banner shows
   "Synced" and the dashboard lists the full dataset (not just 130 seed flights).
2. **Cross-device sync:** user A (browser 1) signs in, adds a flight, "Synced".
   User B (browser 2, different browser/device) signs in → sees the new flight
   (realtime or after reload).
3. **Delete:** user A deletes a flight → gone for user B.
4. **Signed out:** adding a flight shows
   "Signed out — changes saved on this device only"; on sign-in the remote data
   should load and local changes can be re-saved.
5. **Error path:** temporarily break the URL/key (or run before §4 SQL is applied)
   → the banner shows the failure instead of silently succeeding.

## 8. Out of scope / follow-ups

- Client-generated ids `f${Date.now()}` can collide across devices (rare). Not
  addressed here; noted for a future UUID migration.
- No conflict resolution for concurrent edits of the same row (last-write-wins
  via upsert). Acceptable for the current usage.
- `save()` is called with the full array each time; fine at this data size.

## 9. Files touched

- `index.html` — banner element
- `styles.css` — `.sync-status` styles
- `app.js` — status helper + load/save/delete error surfacing
- `ios.html` — banner element + inline CSS + same JS changes
- `AGENTS.md` — note the RLS/grants requirement and seed migration step
- `flyfix.md` — this spec
