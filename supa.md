# Supabase Integration Spec — Flights Database

## Goal

Migrate the flight tracker from pure `localStorage` to Supabase as a remote backend, hosted on GitHub Pages. Multi-device sync, public read access, write access restricted to a single authenticated owner via GitHub OAuth and Row-Level Security.

---

## Constraints

- No build tools, no package manager, no bundler
- Supabase JS client loaded via CDN `<script>` tag only
- All logic stays in `app.js` and `index.html` — no new files except this spec
- Free tier Supabase (500 MB DB, 2 GB bandwidth/month)
- GitHub Pages for static hosting

---

## Supabase Project

| Field | Value |
|---|---|
| Project URL | `https://sswwadgaygrbadqcgyxq.supabase.co` |
| Anon (public) key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzd3dhZGdheWdyYmFkcWNneXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzMTY1NzIsImV4cCI6MjEwMDg5MjU3Mn0.cJ5EZD1Pinfx-Vqp_j_9vU_44uV-0lw4kSxKpjED70w` |
| Auth provider | GitHub OAuth |
| GitHub Pages URL | `https://oceanic55.github.io/fly/` |
| Owner user UUID | _set after first login_ |

These two values go directly in `app.js` as top-level constants. The anon key is safe to commit because RLS enforces write restrictions at the database level.

```js
const SUPABASE_URL = 'https://sswwadgaygrbadqcgyxq.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzd3dhZGdheWdyYmFkcWNneXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzMTY1NzIsImV4cCI6MjEwMDg5MjU3Mn0.cJ5EZD1Pinfx-Vqp_j_9vU_44uV-0lw4kSxKpjED70w'
```

---

## Database Schema

### Table: `flights`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | Primary key (matches existing `f1`, `f2`, … format) |
| `date` | `date` | ISO 8601 (`YYYY-MM-DD`) |
| `departure` | `text` | IATA code, uppercased |
| `arrival` | `text` | IATA code, uppercased |
| `airline` | `text` | Nullable |
| `aircraft` | `text` | Nullable |
| `created_at` | `timestamptz` | Default `now()`, not used by app |

```sql
create table flights (
  id text primary key,
  date date not null,
  departure text not null,
  arrival text not null,
  airline text,
  aircraft text,
  created_at timestamptz default now()
);
```

### Table: `airports`

| Column | Type | Notes |
|---|---|---|
| `iata` | `text` | Primary key |
| `name` | `text` | Nullable |
| `city` | `text` | Nullable |
| `country` | `text` | Nullable |

```sql
create table airports (
  iata text primary key,
  name text,
  city text,
  country text
);
```

---

## Row-Level Security Policies

Enable RLS on both tables, then apply the following policies.

```sql
-- Enable RLS
alter table flights enable row level security;
alter table airports enable row level security;

-- Public read (unauthenticated visitors can view all data)
create policy "public read flights"
  on flights for select using (true);

create policy "public read airports"
  on airports for select using (true);

-- Owner-only write (replace UUID after first login)
create policy "owner write flights"
  on flights for all
  using      (auth.uid() = 'OWNER-UUID-HERE')
  with check (auth.uid() = 'OWNER-UUID-HERE');

create policy "owner write airports"
  on airports for all
  using      (auth.uid() = 'OWNER-UUID-HERE')
  with check (auth.uid() = 'OWNER-UUID-HERE');
```

The `OWNER-UUID-HERE` placeholder is replaced once with the actual UUID found in Supabase → Authentication → Users after the owner's first GitHub login.

---

## Authentication

Provider: **GitHub OAuth**

Setup steps (one-time):
1. Supabase dashboard → Authentication → Providers → GitHub → enable
2. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
   - Homepage URL: `https://yourusername.github.io/repo-name/`
   - Authorization callback URL: copy from Supabase (format `https://xxxx.supabase.co/auth/v1/callback`)
3. Paste GitHub Client ID and Client Secret into Supabase GitHub provider config
4. Add `https://yourusername.github.io/repo-name/` to Supabase → Authentication → URL Configuration → Redirect URLs

Auth flow in the app:
1. Page loads → `supabase.auth.getSession()` called
2. If session exists → owner mode (full UI)
3. If no session → guest mode (read-only UI)
4. Sign-in button triggers `supabase.auth.signInWithOAuth({ provider: 'github' })`
5. After redirect back, session is restored automatically from URL hash

---

## Changes to `index.html`

### Add Supabase CDN script (before `seed-data.js`)

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

### Add auth bar to `.header-left`

Insert after the Import label:

```html
<div id="authBar">
  <span id="authStatus"></span>
  <button id="signInBtn">Sign in</button>
  <button id="signOutBtn" class="hidden">Sign out</button>
</div>
```

No other DOM changes required.

---

## Changes to `app.js`

### 1. Supabase client init (top of file, after constants)

```js
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
```

### 2. Replace `loadInitialData()`

Old behavior: reads `localStorage`, falls back to `window.SEED_DATA`.

New behavior:
1. Try `supabase.from('flights').select('*')` and `supabase.from('airports').select('*')`
2. If both return data → use it (skip `localStorage` and `SEED_DATA`)
3. If Supabase is unreachable → fall back to `localStorage`, then `SEED_DATA` (offline graceful degradation)
4. `localStorage` is kept as a read cache only — no longer the source of truth

```js
async function loadInitialData() {
  try {
    const [{ data: remoteFlights }, { data: remoteAirports }] = await Promise.all([
      supabase.from('flights').select('*').order('date'),
      supabase.from('airports').select('*').order('iata'),
    ])
    if (remoteFlights && remoteAirports) {
      flights = remoteFlights
      airports = mergeAirportMetadata(remoteAirports)
      localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))
      return
    }
  } catch (_) {}
  // offline fallback
  const saved = localStorage.getItem(storeKey)
  if (saved) {
    const parsed = JSON.parse(saved)
    flights = parsed.flights || []
    airports = mergeAirportMetadata(parsed.airports || [])
    return
  }
  flights = [...window.SEED_DATA.flights]
  airports = [...window.SEED_DATA.airports]
}
```

### 3. Replace `save()`

Old behavior: `localStorage.setItem(...)`.

New behavior: upsert to Supabase. If not authenticated, silently skip (RLS would reject anyway, but we guard in JS too). Also update `localStorage` cache.

```js
async function save() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return  // guest — writes not allowed
  await Promise.all([
    supabase.from('flights').upsert(flights),
    supabase.from('airports').upsert(airports),
  ])
  localStorage.setItem(storeKey, JSON.stringify({ flights, airports }))
}
```

Individual delete operations also need a targeted Supabase call:

```js
// when deleting a flight
await supabase.from('flights').delete().eq('id', id)
```

### 4. Auth state + UI mode

```js
async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession()
  applyAuthUI(session)

  supabase.auth.onAuthStateChange((_event, session) => {
    applyAuthUI(session)
    renderAll()
  })

  document.getElementById('signInBtn').addEventListener('click', () =>
    supabase.auth.signInWithOAuth({ provider: 'github' })
  )
  document.getElementById('signOutBtn').addEventListener('click', () =>
    supabase.auth.signOut()
  )
}

function applyAuthUI(session) {
  const isOwner = !!session
  document.getElementById('authStatus').textContent = isOwner
    ? `Signed in as ${session.user.user_metadata.user_name}`
    : ''
  document.getElementById('signInBtn').classList.toggle('hidden', isOwner)
  document.getElementById('signOutBtn').classList.toggle('hidden', !isOwner)
  // hide write UI for guests
  document.querySelector('[data-tab="entry"]').classList.toggle('hidden', !isOwner)
  document.getElementById('importJson').closest('label').classList.toggle('hidden', !isOwner)
}
```

### 5. Real-time sync

Supabase Realtime pushes a notification whenever the `flights` table changes. Other open tabs/devices re-fetch and re-render automatically.

```js
function subscribeRealtime() {
  supabase
    .channel('flights-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flights' }, async () => {
      const { data } = await supabase.from('flights').select('*').order('date')
      if (data) { flights = data; renderAll() }
    })
    .subscribe()
}
```

Called once after `loadInitialData()` completes.

### 6. Boot sequence

```js
initAuth()
  .then(() => loadInitialData())
  .then(() => { subscribeRealtime(); wireEvents(); renderAll() })
```

---

## Changes to `styles.css`

Small additions only:

- `#authBar` — flex row, `gap: 8px`, `align-items: center`, `margin-left: auto`
- `#authStatus` — `font-size: 12px`, `color: var(--muted)`
- `#signInBtn`, `#signOutBtn` — same style as existing header buttons

---

## One-Time Data Migration

After Supabase tables are created and RLS is in place, seed from the browser console while signed in as the owner:

```js
// Run in browser console on the live page, signed in
const sb = window._sb  // expose client during migration only
await sb.from('flights').upsert(window.SEED_DATA.flights)
await sb.from('airports').upsert(window.SEED_DATA.airports)
```

After this succeeds, `seed-data.js` stays in the repo as an offline fallback but is no longer the primary data source.

---

## GitHub Pages Deployment

1. Push `index.html`, `app.js`, `seed-data.js`, `styles.css` to a public GitHub repo
2. Repo Settings → Pages → Source: Deploy from branch → `main` → root `/`
3. URL: `https://yourusername.github.io/repo-name/`
4. Add this URL to Supabase → Authentication → URL Configuration → Site URL and Redirect URLs

---

## Guest vs Owner UI Summary

| Feature | Guest (not signed in) | Owner (signed in) |
|---|---|---|
| View dashboard | Yes | Yes |
| View flight list | Yes | Yes |
| Add / edit / delete flights | No (tab hidden) | Yes |
| Import JSON | No (button hidden) | Yes |
| Export JSON | Yes | Yes |
| Real-time updates | Yes (via Realtime) | Yes (via Realtime) |

---

## Open Items (need Supabase project details)

- [x] `SUPABASE_URL` — `https://sswwadgaygrbadqcgyxq.supabase.co`
- [x] `SUPABASE_ANON_KEY` — set in app.js
- [ ] `OWNER-UUID-HERE` — obtained after first GitHub login, set in RLS policies
- [ ] GitHub OAuth App Client ID + Secret — set in Supabase dashboard
- [x] GitHub Pages URL — `https://oceanic55.github.io/fly/`
