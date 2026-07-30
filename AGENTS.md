# Flight Log

Fly notes concept with backend.

## Entrypoints

- `index.html` — desktop-oriented UI (tabs, table layout). JS in `app.js`.
- `ios.html` — mobile-optimized PWA (bottom nav, bottom sheet, card layout). JS inline in `<script>`.

Both are independent implementations of the same logic. **Changes to one likely need porting to the other.**

## How to run

No build step. Serve with any static file server:

```sh
python3 -m http.server 8000
```

## Architecture

| Concern | Mechanism |
|---------|-----------|
| State | `localStorage` key `flights-db-v1` |
| Remote sync | Supabase (`flights` / `airports` tables) via CDN-loaded JS v2 |
| Auth | GitHub OAuth via Supabase Auth |
| Real-time | Supabase Realtime subscriptions on `flights` |
| Airport lookup | Wikidata SPARQL query (on-the-fly) |
| Seed data | `window.SEED_DATA` in `seed-data.js` |

- Local writes (add/edit/delete) work without auth. Auth only gates remote Supabase sync.
- `airport-db.json` is a richer airport reference (not consumed directly by the app; `seed-data.js` is the source).
- `data/` has JSON exports of the same flight/airport data (backup snapshots).

## Notable

- Supabase anon key and URL are hardcoded in both `app.js` and inline in `ios.html`.
- `window._sb` is exposed (in `index.html` only) for one-off data migration via browser console:
  ```
  await window._sb.from('flights').upsert(window.SEED_DATA.flights)
  await window._sb.from('airports').upsert(window.SEED_DATA.airports)
  ```
