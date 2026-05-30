---
name: run-app
description: Use when asked to run, launch, start, or screenshot the Janata app locally — web (Expo web + Cloudflare Workers API) or iOS simulator. Captures the exact commands plus the two drift gotchas (missing expo-splash-screen, stale native iOS project) and how to verify each target actually renders.
---

# Running Project Janatha locally

Expo (React Native) frontend + Hono on Cloudflare Workers backend, npm workspaces.
Run from the repo root. Both targets share one Metro bundler on `:8081`.

## Web (frontend + API)

```bash
npm run dev          # concurrently: API on :8787 (wrangler), Expo web on :8081
```

- App: http://localhost:8081  ·  API: http://localhost:8787
- First boot runs `expo start -c` (clears Metro cache) — give it ~20–30s.
- The HTML shell returns 200 even if the JS bundle fails. **Verify by driving it**, not just curling `/`:
  navigate a browser to `http://localhost:8081/` and screenshot, or check the dev log for
  `Web Bundled … (N modules)`. A populated home screen ("Namaste", "UP NEXT FOR YOU", tab bar) = success.
- `GET /api` returns 404 — that's normal (no route at root); the worker is up.

### Gotcha: `Failed to resolve plugin for module "expo-splash-screen"`
The lockfile drifts ahead of `node_modules` (e.g. after pulling a commit that adds a dep/plugin).
Fix: `npm install` from the repo root, then re-run `npm run dev`. The `patch-css` postinstall
prints harmless "Not found" lines for `react-native-css-interop` — ignore them; "Done patching" = ok.

## iOS simulator

```bash
npm run ios          # = cd packages/frontend && npx expo run:ios  (xcodebuild + pod install, then launch)
```

- First native build takes several minutes. If `npm run dev`'s Metro is already on :8081 it logs
  `Skipping dev server` and reuses it. App bundle id: `org.chinmayamission.janata`.
- Verify it rendered (don't trust "launched"):
  ```bash
  xcrun simctl io booted screenshot /tmp/janata-sim.png
  ```
  Wait for the dev log to show `iOS Bundled … (N modules)` first — the dev client shows
  "Bundling %…" → "Downloading 100%" → the actual home screen. A blank/loading frame = not done yet.

### Gotcha: pod install fails `Unable to find a target named 'Janata' … did find 'ChinmayaJanata'`
The native `ios/` dir is **generated** (it's in `.gitignore`; only the Podfile got force-committed) and
has drifted — the on-disk Xcode project is a stale prebuild under the old name `ChinmayaJanata`, while
`app.json` (name "Janata") and the Podfile target `'Janata'` are current. Regenerate it:

```bash
cd packages/frontend
npx expo prebuild --clean -p ios     # wipes ios/, regenerates Janata.xcworkspace + Podfile, runs pod install
npx expo run:ios                     # then build/launch
```

`--clean` overwrites the committed Podfile with the SDK template's (the old custom folly/RN-0.81 fix
is no longer needed on SDK 55 / RN 0.83). Same recipe applies to Android drift with `-p android`.

## Note: local app talks to PROD API
`packages/frontend/.env` sets `EXPO_PUBLIC_API_BASE_URL=https://api.chinmayajanata.org/api` (the
localhost line is commented out). So the running app hits the **production** API, not local `:8787`.
`401`/`403` on `/api/auth/refresh` and `/api/auth/verify` at first load are just the unauthenticated
state, not a failure. To point at the local backend, swap the commented lines in that `.env`.
