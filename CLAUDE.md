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
```

Dev-loop gotcha: the service worker serves the app shell **stale-while-revalidate**, and python's server sends no cache headers so the browser also heuristically caches ES modules. When testing local changes in a browser, unregister the SW + clear CacheStorage (or disable HTTP cache via devtools/CDP) or you will debug stale code.

## Architecture

Module dependency rule: `app.js` (state, boot, routing, all event wiring) orchestrates everything; `ui.js` does all DOM writes and imports only pure modules; `weather.js` (fetch/parse), `astro.js` (ephemeris), `score.js` (scoring), `logic.js` (pure app logic), `tonight.js` (sky content), `lightpollution.js` (atlas decode) are DOM-free. **`astro.js`, `score.js`, `logic.js`, `tonight.js`, `lightpollution.js`, `weather.js` are importable under Node and covered by `tests/`** — new pure logic goes in one of these (usually `logic.js`), never inline in `app.js`/`ui.js`, precisely so it stays testable. Both production bugs to date lived in untested app/ui glue.

### Data flow

1. `refetchAll()` awaits only the main Open-Meteo forecast (14 days hourly, `timeformat=unixtime` → epochs are true UTC instants; the response's IANA `timezone` drives ALL display formatting via cached `Intl.DateTimeFormat` — never the browser's timezone).
2. `buildData()` enriches each hour record with client-side ephemeris (sun/moon altitude, moon phase, visible planets) and scores it (`overallScore`), then groups hours into local-calendar days (DST days correctly have 23/25 columns).
3. **Side-channel fetches** (7Timer seeing, air-quality AOD, multi-model cloud spread, pressure-level winds, Kp, light-pollution tile, spot comparison) run fire-and-forget in parallel, each guarded by a sequence counter against stale location changes, and *patch* hour records + rescore + re-render when they land. Never let one of these block first paint. Follow this pattern for any new data source.
4. Hour records carry **display-unit values** (whatever unit the user chose) *and* **canonical scoring values** (`windMph`, `apparentF`, `visMiles`, km/h `w250`/`w500`) so `score.js` thresholds are unit-independent.

### Scoring

`score.js` is the single source of truth for metric breakpoints, weights (sum = 1.00), hard caps (daylight 0.25, ≥90% cloud 0.20, ≥70% precip 0.25), and the 0.66/0.33 band cutoffs. The Help view and README state these numbers in prose — keep them in sync when changing thresholds. Bands map to CSS classes `band-good/-marginal/-bad` everywhere (tiles, timeline, forecast grid, dots, chips).

### Theming — three layers on CSS variables

`css/style.css` ends with an appended "APPLE WEATHER THEME" section (the shipped hybrid design: frosted panels/chrome + hero banner, but **solid** band colors on tiles/timeline for glanceability — do not make the tiles translucent again). Mode order matters: `body.cb` (color-blind palette) is declared before `body.night` (red mode) so night wins when both apply. Night mode redefines every palette var to a red-luminance ramp (brighter red = better) and red-filters icons/canvas/charts; **any hardcoded blue/white in new CSS is a night-mode light leak** — use the vars, and check night mode after UI changes. `body.sky-day` / `body.sky-twilight` follow the scrubbed hour's sun altitude (set in `renderBanner`); their selectors use `:not(.night)`.

Chart SVGs are the exception: CSS `var()` does not resolve inside SVG presentation attributes, so `ui.js` charts use concrete hex colors on purpose.

### Known quirks

- **7Timer is CORS-dead** (no `Access-Control-Allow-Origin` since mid-2026). The fetch is kept deliberately — it self-heals if they fix headers — so the two console CORS errors per refresh are expected, and seeing/transparency run on physics-based estimates (jet-stream shear via 250/500 hPa winds; AOD for transparency), marked "est." in the UI.
- Ephemeris is low-precision Meeus-style (~±1°, moon includes the parallax term). It's a dashboard, not an almanac — don't chase arcminutes.
- Inputs must be ≥16px font or iOS Safari zooms the page on focus. The viewport pins `maximum-scale=1`; interactive elements carry `touch-action: manipulation`.
- localStorage access is always try/catch'd (private-mode Safari throws). Prefs live under the single key `starcast:prefs`.
- `Number(null) === 0`: never parse optional URL/API params with bare `Number()` — this once relocated the app to 0°N 0°E. `logic.js#parseShareCoords` + its regression test are the pattern.

## Roadmap (Phase 1 & 2 core shipped 2026-08-01; field-test tuning in progress)

**Sky map / AR view — the next big feature.** Plan agreed 2026-08-01:

- **Phase 1 — SHIPPED (2026-08-01)** — "Sky" tab, touch-drag panorama: bright-star catalog as static JSON (1,637 stars, mag ≤ 5, HYG-derived) + 150 constellation-figure polylines (borders deliberately excluded); canvas 2D gnomonic projection around a view direction; drag to look around; stars/planets/moon/sun plotted for the **scrubbed hour** (reuse `astro.js` — added an azimuth counterpart to `altitudeOf`). Works on desktop too. `data/sky.json` is generated by `node tools/build-sky-data.mjs` (checked in; regenerate only to change magnitude/name cutoffs).
- **Phase 2 — core SHIPPED (2026-08-01), field-test tuning in progress** — AR mode button on that view: `DeviceOrientationEvent` drives the view direction (iOS needs `requestPermission()` in a user gesture; Android needs `deviceorientationabsolute`); rotation-matrix conversion (`js/armath.js`) + screen-orientation compensation + low-pass filtering; compass gives magnetic north — corrected to true north via a full WMM2025 spherical-harmonic model in JS (`js/wmm.js` + `js/wmmcof.js`, owner-ratified upgrade over a static declination table, since the error is ~13° in NYC and breaks star identification); optional `getUserMedia` camera passthrough toggle. WMM coefficients regenerate via `node tools/build-wmm.mjs` when WMM2030 releases (late 2029). Sensors cannot be tested headless — now in the owner field-test → fix cycle.

**Deliberately out of scope** (owner-ratified): push notifications & cross-device sync (need a server), ISS passes (needs a real SGP4 propagator; wrong pass times are worse than none), i18n / 24-hour clock, manual Bortle override (light pollution is measured-only by design). **AR/WMM design choices, not bugs — don't "fix" these:** WMM declination is computed at sea level only, no altitude input (compass noise dwarfs the difference from real elevation); sensor fusion is single-stage low-pass only, no Kalman filter; AR/camera state (mode, camera on/off) does not persist across sessions. Phase 3 candidates (not yet built): star-tap object identification, object search/goto arrows.
