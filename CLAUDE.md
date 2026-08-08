# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Starcast is a stargazing-conditions dashboard (inspired by "Good To Stargaze" and Clear Outside), deployed to GitHub Pages at https://joeyphatsjr.github.io/starcast/ from the `main` branch root of https://github.com/JoeyPhatsJr/starcast.

## Hard constraints — never break these

- **Pure static site. No build step, no bundler, no npm dependencies, no CDN scripts, no API keys, ever.** `package.json` exists only for `npm test` (Node's built-in runner) and ESM mode; it must never gain dependencies.
- All asset paths are **relative** (`./css/...`) because the site serves from the `/starcast/` subpath.
- All external APIs must be keyless and CORS-open. Current set: Open-Meteo (forecast, air-quality, geocoding), 7Timer (currently CORS-dead, see below), djlorenz.github.io atlas tiles, NOAA SWPC Kp, BigDataCloud reverse geocode (`api-bdc.io`).
- **Bump `VERSION` in `sw.js` on any change to `index.html`, `css/`, `js/`, or `manifest.webmanifest`.** CI (`.github/workflows/ci.yml`) fails the push if you don't. Add new JS files to the SW `SHELL` list.

## Commands

```bash
npm test                          # node --test tests/*.test.mjs — no install needed
node --test tests/logic.test.mjs  # single test file
node --check js/app.js            # syntax-check a module
python3 -m http.server            # local dev server (exactly how Pages serves it)
node tools/build-sky-data.mjs [local-hyg.csv]  # regen data/sky.json (HYG CSV is 34MB — pass a local copy to skip the download)
node tools/build-wmm.mjs          # regen js/wmmcof.js from tools/WMM2025.COF (next needed: WMM2030, late 2029)
```

**Landing changes on main: never fast-forward.** CI's `sw-version-guard` diffs `HEAD~1..HEAD` on main pushes, so the sw.js VERSION change must be in the tip diff — merge PRs with a merge commit or squash (`gh pr merge N --merge --delete-branch`). Pushing main deploys to Pages within ~a minute.

Dev-loop gotcha: the service worker serves the app shell **stale-while-revalidate**, and python's server sends no cache headers so the browser also heuristically caches ES modules. When testing local changes in a browser, unregister the SW + clear CacheStorage (or disable HTTP cache via devtools/CDP) or you will debug stale code.

## Architecture

Module dependency rule: `app.js` (state, boot, routing, all event wiring, permissions, sensor/camera lifecycle) orchestrates everything; `ui.js` does all DOM writes and imports only pure modules; `weather.js` (fetch/parse), `astro.js` (ephemeris), `score.js` (scoring), `logic.js` (pure app logic), `tonight.js` (sky content), `lightpollution.js` (atlas decode), `skymap.js` (gnomonic projection/view math/draw lists), `armath.js` (device orientation → view), `wmm.js` + generated `wmmcof.js` (magnetic declination) are DOM-free. **All of those pure modules are importable under Node and covered by `tests/`** — new pure logic goes in one of these, never inline in `app.js`/`ui.js`, precisely so it stays testable. Both production bugs to date lived in untested app/ui glue.

### Data flow

1. `refetchAll()` awaits only the main Open-Meteo forecast (14 days hourly, `timeformat=unixtime` → epochs are true UTC instants; the response's IANA `timezone` drives ALL display formatting via cached `Intl.DateTimeFormat` — never the browser's timezone).
2. `buildData()` enriches each hour record with client-side ephemeris (sun/moon altitude, moon phase, visible planets) and scores it (`overallScore`), then groups hours into local-calendar days (DST days correctly have 23/25 columns).
   The timeline scrubs at **minute resolution**: `getSelectedHour` (ui.js, the single accessor for the scrubbed record) interpolates between bracketing hour records via `logic.js#interpolateHours` (numerics lerp generically, categoricals/non-numerics snap to nearest hour, `time` is exact) and rescores the synthesized record; the strip is two stacked inline gradients — a per-hour sun-altitude sky backdrop (`--sky-nightc/-twic/-dayc` vars, night-mode red-ramped) and a bottom-30% score bar whose hourly band colors fade into each other — plus `.tl-tick` labels on the local 6-hour boundaries (DST-located via `localHour`).
3. **Side-channel fetches** (7Timer seeing, air-quality AOD, multi-model cloud spread, pressure-level winds, Kp, light-pollution tile, spot comparison) run fire-and-forget in parallel, each guarded by a sequence counter against stale location changes, and *patch* hour records + rescore + re-render when they land. Never let one of these block first paint. Follow this pattern for any new data source.
4. Hour records carry **display-unit values** (whatever unit the user chose) *and* **canonical scoring values** (`windMph`, `apparentF`, `visMiles`, km/h `w250`/`w500`) so `score.js` thresholds are unit-independent.

### Scoring

`score.js` is the single source of truth for metric breakpoints, weights (sum = 1.00), hard caps (daylight 0.25, ≥90% cloud 0.20, ≥70% precip 0.25), and the 0.66/0.33 band cutoffs. The Help view and README state these numbers in prose — keep them in sync when changing thresholds. Bands map to CSS classes `band-good/-marginal/-bad` everywhere (tiles, timeline, forecast grid, dots, chips).

### Theming — three layers on CSS variables

`css/style.css` ends with an appended "APPLE WEATHER THEME" section (the shipped hybrid design: frosted panels/chrome + hero banner, but **solid** band colors on tiles/timeline for glanceability — do not make the tiles translucent again). Mode order matters: `body.cb` (color-blind palette) is declared before `body.night` (red mode) so night wins when both apply. Night mode redefines every palette var to a red-luminance ramp (brighter red = better) and red-filters icons/canvas/charts; **any hardcoded blue/white in new CSS is a night-mode light leak** — use the vars, and check night mode after UI changes. `body.sky-day` / `body.sky-twilight` follow the scrubbed hour's sun altitude (set in `renderBanner`); their selectors use `:not(.night)`.

Chart SVGs are the exception: CSS `var()` does not resolve inside SVG presentation attributes, so `ui.js` charts use concrete hex colors on purpose. The sky canvas likewise uses concrete colors and is red-filtered by the `body.night :is(...)` selector; the AR camera `<video>` is deliberately NOT in that filter list.

### Sky tab & AR (Phases 1–2, shipped)

- `state.sky = {az, alt, fov}` (+ `roll` while AR is active) drives `UI.renderSky(state)`; drag/pinch/wheel live in `wireSky()` via pure `dragView`/`zoomView`; renders are rAF-coalesced through `scheduleSkyRender()`. Time source is the scrubbed hour (`getSelectedHour`), falling back to `new Date()`.
- `data/sky.json` (1,637 stars mag ≤ 5 from HYG, CC BY-SA 4.0; 150 constellation FIGURE polylines from d3-celestial, BSD-3 — borders are owner-ruled out) is checked in, lazy-fetched on first Sky visit, and in the SW shell. HYG's CSV stores RA in HOURS — the generator multiplies by 15.
- **AR sign conventions are field-verified — do not "re-derive" them.** Each lives in exactly one place: roll compensation is `ctx.rotate(-roll)` in `renderSky`; declination is east-positive with true az = magnetic az + D (`rotateBasisZ(raw, decl − iOSoffset)` in `onOrientation`); screen-angle compensation is `R·Rz(screenAngle)` in `armath.js`. If a device shows a mirrored axis, flip the one sign at its home, never in callers.
- **Never smooth az/alt/roll separately** — they are singular (mutually compensating) near the zenith and independent smoothing makes the view spin (2026-08-03 field bug). AR smooths the rigid basis (`orientationToBasis` → `rotateBasisZ` → `smoothBasis` → atomic `basisToView`); a regression test locks zenith dwell to <6 px/frame.
- iOS: `DeviceOrientationEvent.requestPermission()` MUST be called synchronously inside the tap gesture; the compass fusion (`headingOffset`, k=0.05) is frozen above 60° view altitude where compass headings are garbage. Android path prefers `deviceorientationabsolute` once seen.
- AR auto-enters on the Sky tab (`shouldAutoEnterAR` in logic.js: pref `arAuto` default true, coarse pointer, sensor API, finite location; silent failures on auto-attempts). Manual AR-off persists `arAuto: false`. Camera passthrough is strictly opt-in, never auto-starts; its stream lifecycle is race-guarded (`camStarting` + late-resolve teardown) and torn down on every exit path.

### Known quirks

- **7Timer is CORS-dead** (no `Access-Control-Allow-Origin` since mid-2026). The fetch is kept deliberately — it self-heals if they fix headers — so the two console CORS errors per refresh are expected, and seeing/transparency run on physics-based estimates (jet-stream shear via 250/500 hPa winds; AOD for transparency), marked "est." in the UI.
- Ephemeris is low-precision Meeus-style (~±1°, moon includes the parallax term). It's a dashboard, not an almanac — don't chase arcminutes.
- Inputs must be ≥16px font or iOS Safari zooms the page on focus. The viewport pins `maximum-scale=1`; interactive elements carry `touch-action: manipulation`.
- localStorage access is always try/catch'd (private-mode Safari throws). Prefs live under the single key `starcast:prefs`.
- `Number(null) === 0`: never parse optional URL/API params with bare `Number()` — this once relocated the app to 0°N 0°E. `logic.js#parseShareCoords` + its regression test are the pattern.
- Browser verification: Playwright works well against `python3 -m http.server` (unregister SW + clear caches first). Synthetic `new DeviceOrientationEvent(...)` dispatches exercise the whole AR pipeline headlessly (they have `absolute: false`, no `webkitCompassHeading`). Synthetic `PointerEvent` dispatches can't satisfy `setPointerCapture` (throws NotFoundError) — use real CDP mouse input for drag tests.
- `savePrefs()` serializes an explicit allowlist — a new pref that isn't added to BOTH the destructure and the JSON.stringify silently doesn't persist (bit us once with `arAuto`).

## OPEN ISSUE — AR motion still janky (tabled 2026-08-04)

Owner report after the zenith fix: general AR movement "is still janky and moves a lot" (not zenith-specific). Roll sign, declination, and zenith stability are all confirmed good — this is about tracking feel. Leading suspects for whoever picks this up:

1. **Per-event smoothing is event-rate dependent**: `smoothBasis(…, k=0.25)` applies k per sensor event, so responsiveness/jitter varies with the device's event rate (iOS ~60 Hz, some Androids 15–20 Hz). Fix candidate: time-based constant, `k = 1 − exp(−dt/τ)` with τ ≈ 60–100 ms, using event timestamps.
2. **No inter-event interpolation**: renders happen only when sensor events arrive (rAF-coalesced but not rAF-driven). At low event rates the view steps visibly. Fix candidate: while AR is active, run a continuous rAF loop that keeps easing the displayed basis toward the latest sensor basis.
3. Compass fusion feeding az jitter on iOS (raise the freeze threshold, lower k, or gate on `webkitCompassAccuracy` if present).

Tuning constants live in `onOrientation` (0.25, 0.05) and the 60°-altitude compass freeze. The zenith regression test in `tests/armath.test.mjs` must stay green through any smoothing change.

## Roadmap (Phase 1 & 2 shipped; AR feel-tuning tabled — see OPEN ISSUE above)

**Sky map / AR view — the next big feature.** Plan agreed 2026-08-01:

- **Phase 1 — SHIPPED (2026-08-01)** — "Sky" tab, touch-drag panorama: bright-star catalog as static JSON (1,637 stars, mag ≤ 5, HYG-derived) + 150 constellation-figure polylines (borders deliberately excluded); canvas 2D gnomonic projection around a view direction; drag to look around; stars/planets/moon/sun plotted for the **scrubbed hour** (reuse `astro.js` — added an azimuth counterpart to `altitudeOf`). Works on desktop too. `data/sky.json` is generated by `node tools/build-sky-data.mjs` (checked in; regenerate only to change magnitude/name cutoffs).
- **Phase 2 — SHIPPED (2026-08-01; field fixes 08-03: roll sign, zenith basis smoothing, AR default-on; motion feel still open)** — AR mode on that view: `DeviceOrientationEvent` drives the view direction (iOS needs `requestPermission()` in a user gesture; Android needs `deviceorientationabsolute`); rotation-matrix conversion (`js/armath.js`) + screen-orientation compensation + low-pass filtering; compass gives magnetic north — corrected to true north via a full WMM2025 spherical-harmonic model in JS (`js/wmm.js` + `js/wmmcof.js`, owner-ratified upgrade over a static declination table, since the error is ~13° in NYC and breaks star identification); optional `getUserMedia` camera passthrough toggle. WMM coefficients regenerate via `node tools/build-wmm.mjs` when WMM2030 releases (late 2029). Sensors cannot be tested headless — now in the owner field-test → fix cycle.

**Small deferred polish — SHIPPED 2026-08-07** (label dedupe, deltaY-scaled wheel zoom, roll-aware star-cull margin, alt-clamp dedupe). The flagged `wmm.declination` pole NaN was **disproven** — floating-point `cos(π/2)` ≈ 6e-17 keeps every division finite; a regression test in `tests/wmm.test.mjs` locks finite output at ±90° with no clamp needed.

**Deliberately out of scope** (owner-ratified): push notifications & cross-device sync (need a server), ISS passes (needs a real SGP4 propagator; wrong pass times are worse than none), i18n / 24-hour clock, manual Bortle override (light pollution is measured-only by design). **AR/WMM design choices, not bugs — don't "fix" these:** WMM declination is computed at sea level only, no altitude input (compass noise dwarfs the difference from real elevation); sensor fusion is single-stage low-pass only, no Kalman filter; AR/camera state (mode, camera on/off) does not persist across sessions. Phase 3 candidates (not yet built): star-tap object identification, object search/goto arrows.
