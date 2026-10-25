# Firebase migration implementation specification

## 1. Goal and scope

Migrate the Flight Log's hosted data and GitHub sign-in from Supabase to Firebase while preserving the existing no-build, static HTML architecture and both independent interfaces:

- `index.html` + `app.js` (desktop)
- `ios.html` (mobile/PWA, inline JavaScript)

This is a specification only. It does not create Firebase resources or change application code.

### Preserve

- The app's current **one globally shared flight log**. Every signed-in user works with the same flights and airport metadata; there is no per-user data partition.
- Local flight editing, import/export, and `localStorage` fallback while signed out or offline.
- GitHub as the sign-in provider.
- Realtime updates for flights in both interfaces.
- Existing seed data in `seed-data.js` and airport metadata enrichment behavior.
- User-visible sync status (`#syncStatus`), including visible failures instead of silent fallback.

### Exclude

- Per-user private logs, role/owner-based access, custom backend/API, build tooling, and replacement of Wikidata lookup.
- Removing or overwriting the existing Supabase project/data during initial rollout.

## 2. Current behavior and migration implications

The current client reads and writes `flights` and `airports` tables as full arrays after authentication. Both local implementations keep a cache at `localStorage['flights-db-v1']`. Seed data is 130 flights plus airport reference records. Flight IDs are currently strings such as `f1` and newly created IDs use `f${Date.now()}`. Airport records are keyed by IATA code. The current dataset is globally shared, not scoped to the GitHub identity.

Firebase's browser SDK can be loaded as modular ES modules from the official CDN without introducing a build step. The pages must be served over HTTP(S); opening `index.html` via `file://` is not a supported hosting/OAuth setup. Configure Firebase Auth's authorized domains for the actual development and production hosts.

## 3. Firebase services and project setup

Create one Firebase project and enable:

1. **Authentication → GitHub** provider. Create/configure a GitHub OAuth app using the callback URL shown by Firebase Authentication. Add the GitHub client ID and secret in Firebase Console (the secret must never be put in repository files).
2. **Authentication → Authorized domains**: add the production hostname and development hostname(s) used to serve the app. Do not use `file://`.
3. **Cloud Firestore**, production mode, in the region nearest the users. Record this as an operational choice because Firestore database region cannot be changed in place.
4. **Firebase web app** configuration. The web config / API key is public client configuration, not an authorization boundary; Firestore Security Rules are the boundary.
5. **Firebase CLI** locally for rules deployment and (optionally) emulator use. Keep project identifiers/configuration in `firebase.json` and `.firebaserc`; no service account key or Admin SDK credential is needed by the static client.

Use official Firebase JS SDK modules from a pinned versioned CDN URL (not an unversioned `latest` URL). In each entrypoint import only `initializeApp`, Auth functions (`getAuth`, `GithubAuthProvider`, `signInWithPopup` or redirect flow, `signOut`, `onAuthStateChanged`), and Firestore functions (`getFirestore`, `doc`, `getDoc`, `setDoc`, `onSnapshot`, `serverTimestamp`). Avoid adding Firebase compat globals or a package/build step.

Suggested Firestore layout:

```text
sharedData/flights
  flights: [ { id, date, departure, arrival, airline, aircraft }, ... ]
  updatedAt: server timestamp
  updatedBy: Firebase uid

sharedData/airports
  airports: [ { iata, name, city, country }, ... ]
  updatedAt: server timestamp
  updatedBy: Firebase uid
```

These two documents preserve the current whole-array persistence model and are comfortably within Firestore's document size limit for the current scope. Treat each record as plain JSON data. Do not store derived UI state, tokens, or user secrets. Keep `id`/`iata` fields inside array records; array elements do not have Firestore document IDs or independent rules.

## 4. Access model and security decision

The current product behavior allows any authenticated GitHub user to change the same global dataset. That is a deliberate, broad write permission. Implement that behavior explicitly in `firestore.rules`, with unauthenticated reads/writes denied:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sharedData/{document} {
      allow read, write: if request.auth != null
        && document in ['flights', 'airports'];
    }
  }
}
```

Validate the rule syntax and deploy with Firebase CLI before enabling the new client. Do not use open public read/write rules. The above policy still means any account able to sign in via an enabled provider can overwrite/delete the entire shared document. For the first implementation, constrain who can sign in operationally: enable only GitHub, and restrict GitHub app access to trusted users if that is compatible with the account setup. If public sign-ups are expected, add an explicit allowlist of Firebase UIDs (or a trusted custom claim managed outside the static app) before launch. Never put an allowlist secret or admin credential in client code.

Important tradeoff: because this preserves global sharing, local edits made by any signed-in user affect everyone's view. Firebase Auth authenticates the user; it does not by itself make shared writes private or safe from accidental/hostile overwrite.

## 5. Client architecture

### 5.1 Shared backend module

Add `firebase-client.js` as an ES module with the project's public Firebase web config placeholders and narrowly scoped functions:

- Initialize and export `auth` and `db` exactly once per page.
- Export `signIn()`, `signOut()`, `watchAuth(callback)`, and `getCurrentUser()` as needed.
- Export `loadSharedData()` to fetch both documents, return `{flights, airports}`, and distinguish a missing document from a failed request.
- Export `saveSharedData({flights, airports}, user)` to write both documents with `updatedAt: serverTimestamp()` and `updatedBy: user.uid`.
- Export `watchFlights(callback, onError)` for snapshot updates; unsubscribe cleanly when the page is torn down or auth is lost.

Because both pages use independent application code, share backend primitives in the module but port UI/data orchestration to both entrypoints. Change `index.html` to load `app.js` as `type="module"`; change `ios.html` inline app script to `type="module"` or move its logic to a module only if needed to satisfy module imports. Keep `seed-data.js` available as a classic script or convert it carefully to a module export; do not accidentally make `window.SEED_DATA` unavailable.

### 5.2 Authentication

- Replace Supabase session initialization and `signInWithOAuth` with Firebase `onAuthStateChanged`.
- Use `GithubAuthProvider` and `signInWithPopup` on desktop when supported. For Safari/PWA/mobile popup restrictions, use Firebase redirect sign-in (`signInWithRedirect`) and consume the redirect result at startup (`getRedirectResult`). The exact flow can be selected by capability/platform, but both pages must handle popup-blocked errors by offering/using redirect.
- Sign out using Firebase `signOut(auth)`.
- Render GitHub display name (prefer `displayName`, fall back to email, then a short uid) into `#authStatus`.
- When auth becomes signed out, unsubscribe from Firestore and keep local editing available. Avoid treating a stale cached Firebase user object as proof of an active session.
- Surface auth errors in `#syncStatus`, with concise user-safe text and details in `console.error`.

### 5.3 Initial load and offline cache

Startup sequence for both interfaces:

1. Read `flights-db-v1` from local storage immediately and render it if present for responsive startup; otherwise render seed data.
2. Initialize Firebase and observe auth state.
3. If signed out, remain local-only and show the existing signed-out status when the user attempts a write (do not send unauthenticated requests).
4. If signed in, read `sharedData/flights` and `sharedData/airports`.
5. If both documents exist, validate their fields, replace in-memory state, merge airport records with `window.SEED_DATA.airports` using the existing code/canonicalization behavior, update local cache, render, and report “Synced”.
6. If one/both are absent in a newly provisioned project, perform the one-time bootstrap policy below; do not mistake a permission/network failure for an absent document.
7. If reads fail, retain local/seed data and report a visible error. Do not overwrite remote documents automatically after an error.

Enable Firestore offline persistence only if it works reliably for the supported Safari/PWA versions and does not conflict with the app's own cache. The first implementation may rely on the current `localStorage` cache to avoid additional persistence complexity.

### 5.4 Writes and consistency

Preserve the current full-array write model for this small, globally shared dataset:

- Every flight/airport mutation updates memory and localStorage first.
- Only a signed-in user writes the resulting flight and airport documents.
- Save both documents using Firestore `writeBatch` or equivalent atomic batch writes so one half cannot succeed while the other fails. Update metadata on both documents.
- On success, show “Synced”. On failure, keep local changes and show “Sync failed: … — saved on this device only”. Never show success before the remote write is acknowledged.
- Deletes must update the full flights document; do not leave stale deleted flights in remote storage.
- Import is a replacement operation in current behavior. Display/confirm this clearly if needed, write both remote documents atomically when signed in, and report errors.
- Do not merge stale local state into remote data automatically after a sign-in. When remote data exists, it is canonical and replaces the cache. When remote data is absent, bootstrap once from current local data if available, otherwise seed data. This prevents a stale device cache from silently overwriting the shared log.

For deterministic concurrent edits, maintain the current last-write-wins whole-document behavior and document it. Before writing, optionally compare each snapshot's `updatedAt` with the last observed version; if changed remotely, reload and inform the user instead of blindly replacing. This conflict check is recommended because multiple users share the document, but can be a follow-up if it materially complicates implementation. Do not add CRDTs or per-flight schema in this migration.

### 5.5 Realtime

- Attach `onSnapshot` to `sharedData/flights` only while signed in.
- Ignore the initial snapshot if it duplicates the completed initial load, or handle it idempotently.
- On remote change, validate the payload, replace in-memory flights and local cache, rerender, and set “Synced”.
- Avoid echo loops: snapshot handlers only update local state/cache and must not call the persistence function.
- On listener error, show an error banner and keep cached data; retry only through Firebase's listener behavior or a deliberate bounded reconnect strategy.
- Airport data changes infrequently; it can be fetched on authenticated startup without realtime subscription. Reload it on successful local metadata save/import.

## 6. Bootstrap and migration of existing data

1. Create/configure Firebase and deploy rules before the first app write.
2. Export a backup from the app's Export button and retain the existing `data/flights.json`, `data/airports.json`, and `seed-data.js`. Do not delete Supabase or its data during rollout.
3. Choose the canonical initial dataset. If Supabase is reachable, export current remote `flights` and `airports`; otherwise use the latest trusted app export. The repository seed is a fallback/reference, not automatically assumed to contain all later edits.
4. Provide a one-time admin-only import path outside public app code. Recommended: Firebase Console import is not suitable for arbitrary JSON documents; instead use a temporary local Admin SDK script authenticated with Application Default Credentials (`gcloud auth application-default login`) or a controlled one-off tool. Never commit service account JSON or embed privileged credentials. The script should validate counts/schema, write the two documents, print counts, and be removed/not committed or retained without secrets.
5. If implementing automatic bootstrap instead, specify that only when both shared documents are absent and an authenticated user signs in. Use a Firestore transaction to create-if-absent; resolve a race by reading the winner's documents. Do not bootstrap just because a read failed.
6. Verify records and counts in Firebase Console and app before directing users to the new deployment.
7. Keep a timestamped JSON export before and after cutover. Supabase remains an archive until Firebase has been verified and a rollback window has passed.

The standard browser client must not be granted admin access. The static app config is not a secret; Admin SDK credentials are.

## 7. Configuration, deployment, and files

Implementation should add/update:

- `firebase-client.js` — Firebase web config and shared auth/Firestore functions.
- `firestore.rules` — authenticated-only rules for the two shared documents.
- `firebase.json` — Firestore rules deployment config (hosting config only if Firebase Hosting is selected).
- `.firebaserc` — selected Firebase project alias; avoid embedding personal credentials.
- `index.html` — remove Supabase CDN include; load app module.
- `app.js` — replace Supabase persistence/auth/realtime calls with Firebase adapter.
- `ios.html` — replace its independent Supabase code with equivalent Firebase behavior.
- `fire.md` — this specification, update as implementation decisions settle.
- `AGENTS.md` — replace Supabase architecture notes with Firebase and shared-data security description after migration is complete.

Serve/deploy over HTTPS. Firebase Hosting is optional; any static HTTPS host works once authorized domains and redirect handling are correct. For local development, use an HTTP server on localhost, which Firebase Auth supports as a development domain. Do not test OAuth by opening an HTML file directly.

## 8. Error and status behavior

Use `#syncStatus` consistently in desktop and mobile:

- `Signed out — changes saved on this device only`
- `Synced`
- `Firebase unavailable — showing local data`
- `Sign-in failed: <safe summary>`
- `Sync failed: <safe summary> — saved on this device only`
- `Remote data is missing — initializing shared dataset` only during a verified bootstrap

Avoid exposing tokens, OAuth callback payloads, raw config, or excessive stack traces to the UI. Log diagnostic details to the console. Treat permission-denied distinctly from offline/network failure because it usually indicates Firebase Rules/configuration errors.

## 9. Acceptance criteria

### Auth

- Both pages sign in with GitHub from an HTTPS deployment and return to the same page.
- Safari/mobile fallback works when popups are unavailable.
- Sign-out updates UI and stops realtime listeners.
- Invalid provider/domain setup produces a visible actionable error, not a dead button.

### Data and sharing

- A clean browser loads the canonical shared flights and airports after sign-in.
- Signed-in user A adds/edits/deletes a flight; user B sees the update live or after reload.
- An airport metadata update is persisted and appears on both entrypoints.
- Signed-out users can add/edit/delete locally; reload retains the local cache.
- Failed remote writes never report “Synced” and preserve local changes.
- A remote dataset missing only one document is handled without silently replacing existing data.
- Realtime updates do not trigger write loops or duplicate entries.
- Import/export round-trips the same schema.
- Firestore rejects unauthenticated reads/writes and authenticated access to any path outside `sharedData/flights` and `sharedData/airports`.

### Migration and operations

- Record counts and representative flight/airport rows match the chosen export.
- A JSON backup exists before cutover and rollback instructions are documented.
- No service-account key, GitHub OAuth secret, or privileged credential is in the repository.
- Both app pages are hosted over HTTP(S), and Firebase authorized domains match.

## 10. Rollout and rollback

1. Provision Firebase, configure GitHub Auth, deploy Rules, import canonical data, and verify in a staging URL.
2. Implement both entrypoints behind the same Firebase config and verify all acceptance criteria.
3. Keep a pre-cutover export and leave Supabase untouched during the rollback window.
4. Deploy the Firebase version. Monitor auth and sync errors and confirm cross-device behavior.
5. Roll back by redeploying the prior static files and Supabase config; do not attempt automatic bidirectional sync between services.
6. After the rollback window and a verified backup, separately decide whether to decommission Supabase. Decommissioning is outside this migration implementation.

## 11. Implementation order

1. Provision Firebase project, GitHub provider, domains, Firestore, and rules.
2. Decide canonical dataset and create/verify backup.
3. Import canonical data into the two shared documents.
4. Implement shared Firebase module and migrate desktop entrypoint.
5. Port the same behavior to `ios.html`.
6. Run manual acceptance checks on desktop Safari and mobile Safari/PWA, including auth redirects, offline cache, realtime, import/export, and denied rules.
7. Update project documentation and remove Supabase client references only after Firebase verification.
8. Deploy and preserve the rollback export.
