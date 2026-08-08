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

Module dependency rule: `app.js` (state, boot, routing, all event wiring, permissions, sensor/camera lifecycle) orchestrates everything; `ui.js` does all DOM writes and imports only pure modules; `weather.js` (fetch/parse), `astro.js` (ephemeris), `score.js` (scoring), `logic.js` (pure app logic), `tonight.js` (sky content), `lightpollution.js` (atlas decode), `skymap.js` (gnomonic projection/view math/draw lists/star colour/label placement/picking), `armath.js` (device orientation → view, motion filtering), `wmm.js` + generated `wmmcof.js` (magnetic declination) are DOM-free. **All of those pure modules are importable under Node and covered by `tests/`** — new pure logic goes in one of these, never inline in `app.js`/`ui.js`, precisely so it stays testable. Both production bugs to date lived in untested app/ui glue.

### Data flow

1. `refetchAll()` awaits only the main Open-Meteo forecast (14 days hourly, `timeformat=unixtime` → epochs are true UTC instants; the response's IANA `timezone` drives ALL display formatting via cached `Intl.DateTimeFormat` — never the browser's timezone).
2. `buildData()` enriches each hour record with client-side ephemeris (sun/moon altitude, moon phase, visible planets) and scores it (`overallScore`), then groups hours into local-calendar days (DST days correctly have 23/25 columns).
   The timeline scrubs at **minute resolution**: `getSelectedHour` (ui.js, the single accessor for the scrubbed record) interpolates between bracketing hour records via `logic.js#interpolateHours` (numerics lerp generically, categoricals/non-numerics snap to nearest hour, `time` is exact) and rescores the synthesized record; the strip is a per-hour sun-altitude sky gradient (`--sky-nightc/-twic/-dayc` vars, night-mode red-ramped) with `.tl-tick` labels on the local 6-hour boundaries (DST-located via `localHour`); `#score-strip` below it is band-accurate — the interpolated score is sampled every 10 min through `scoredRecordAt` (the same path as the banner) so bar color and verdict can never disagree; the `● LIVE` button (`jumpToLive` in app.js) snaps back to the current day/hour/minute.
3. **Side-channel fetches** (7Timer seeing, air-quality AOD, multi-model cloud spread, pressure-level winds, Kp, light-pollution tile, spot comparison) run fire-and-forget in parallel, each guarded by a sequence counter against stale location changes, and *patch* hour records + rescore + re-render when they land. Never let one of these block first paint. Follow this pattern for any new data source.
4. Hour records carry **display-unit values** (whatever unit the user chose) *and* **canonical scoring values** (`windMph`, `apparentF`, `visMiles`, km/h `w250`/`w500`) so `score.js` thresholds are unit-independent.

### Scoring

`score.js` is the single source of truth for metric breakpoints, weights (sum = 1.00), hard caps (daylight 0.25, ≥90% cloud 0.20, ≥70% precip 0.25), and the 0.66/0.33 band cutoffs. The Help view and README state these numbers in prose — keep them in sync when changing thresholds. Bands map to CSS classes `band-good/-marginal/-bad` everywhere (tiles, timeline, forecast grid, dots, chips).

### Theming — three layers on CSS variables

`css/style.css` ends with an appended "APPLE WEATHER THEME" section (the shipped hybrid design: frosted panels/chrome + hero banner, but **solid** band colors on tiles/timeline for glanceability — do not make the tiles translucent again). Mode order matters: `body.cb` (color-blind palette) is declared before `body.night` (red mode) so night wins when both apply. Night mode redefines every palette var to a red-luminance ramp (brighter red = better) and red-filters icons/canvas/charts; **any hardcoded blue/white in new CSS is a night-mode light leak** — use the vars, and check night mode after UI changes. `body.sky-day` / `body.sky-twilight` follow the scrubbed hour's sun altitude (set in `renderBanner`); their selectors use `:not(.night)`.

Chart SVGs are the exception: CSS `var()` does not resolve inside SVG presentation attributes, so `ui.js` charts use concrete hex colors on purpose. The sky canvas likewise uses concrete colors and is red-filtered by the `body.night :is(...)` selector; the AR camera `<video>` is deliberately NOT in that filter list.

### Sky tab & AR (Phases 1–3, shipped)

- `state.sky = {az, alt, fov}` (+ `roll` while AR is active) drives `UI.renderSky(state)`; drag/pinch/wheel/keyboard live in `wireSky()` via pure `dragView`/`zoomView`/`clampView`; renders are rAF-coalesced through `scheduleSkyRender()`. Time source is the scrubbed hour (`getSelectedHour`), falling back to `new Date()`.
- `data/sky.json` (1,637 stars mag ≤ 5 from HYG with B−V colour + Bayer designations, CC BY-SA 4.0; 150 constellation FIGURE polylines, 89 constellation label anchors, and 5 simplified Milky Way brightness contours from d3-celestial, BSD-3 — constellation *borders* are owner-ruled out) is checked in, lazy-fetched on first Sky visit, and in the SW shell. HYG's CSV stores RA in HOURS — the generator multiplies by 15.
- **Star row layout is `[ra, dec, mag, bv, properName?, designation?]`** with trailing slots trimmed and a literal `0` in slot 4 meaning "has a designation but no proper name". Changing this means changing `starDrawList`, `tests/skydata.test.mjs`, and the generator together.
- **Gnomonic sends great circles to straight lines.** The horizon is therefore solved in closed form (`horizonY` = `h/2 + tan(viewAlt)·f`), which also gives the ground fill for free — do not "fix" this back into a sampled polyline. Only constant-altitude circles are small circles and need sampling (`gridDrawList`).
- **Filled regions must be near-plane clipped, not vertex-dropped.** `polygonDrawList`/`clipNear` exist because dropping behind-camera vertices from a Milky Way ring re-closes it across the wrong side of the sky and floods the screen. Rings are filled `evenodd` per brightness level so the dark rifts stay dark.
- Tap-to-identify: `renderSky` rebuilds a screen-space hit list every frame; `UI.pickSky(clientX, clientY)` un-rotates the AR roll and calls pure `pickNearest`. The selection is stored as sky coordinates so the reticle tracks through pans, zooms and time scrubs.
- Labels go through one pure `placeLabels` pass. Its `blocked` argument is seeded with the *DOM* chrome rects (tool buttons, info card) because those float above the canvas — a label drawn under them is invisible, not merely overlapping.
- Canvas colours are concrete rgb/hex (CSS vars don't resolve in canvas). Use `toRgba()` for anything that needs alpha: a naive `.replace('rgb(', 'rgba(')` silently no-ops on hex and once painted every planet halo as a solid square.
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
- Browser verification: Playwright works well against `python3 -m http.server`. Synthetic `new DeviceOrientationEvent(...)` dispatches exercise the whole AR pipeline headlessly (they have `absolute: false`, no `webkitCompassHeading`); a full alpha 0→360 sweep should walk the caption through all eight cardinals. Synthetic `PointerEvent` dispatches can't satisfy `setPointerCapture` — `wireSky` try/catches it precisely so headless drag/tap tests work, so no CDP mouse input is needed.
- **The SW re-registers on every page load**, so unregistering once is not enough: clear registrations *and* CacheStorage, then reload, every time you want fresh modules. Two other traps cost real time here — navigating to the *same* URL including its `#fragment` is a no-op (the page never reloads, so you silently test stale code), and `python3 -m http.server` sends no cache headers so the browser heuristically caches ES modules on top of the SW. A dev-only static server that sends `Cache-Control: no-store` removes the second layer.
- `savePrefs()` serializes an explicit allowlist — a new pref that isn't added to BOTH the destructure and the JSON.stringify silently doesn't persist (bit us once with `arAuto`).

### AR motion filtering (reworked 2026-08-08 — the "janky / moves a lot" fix)

A sensor event now only updates `state.ar.target`; a **continuous rAF loop** (`arFrame`) eases `state.ar.basis` toward it and redraws, then parks itself once converged and still. Rendering straight off the sensor stream made low-rate devices step visibly. Four pieces, all pure and tested in `tests/armath.test.mjs`:

- `smoothingAlpha(dt, tau)` — `1 − exp(−dt/tau)`, so the filter behaves the same at 60 Hz and 15 Hz. The old fixed `k = 0.25` per event did not.
- `updateRate(tracker, basis, dt, window)` — angular rate as **net displacement over a fixed window**. Differentiating per event is secretly rate-dependent: the per-event delta is a magnitude, so noise never cancels and the same jitter reads as 18°/s at 60 Hz but 4.5°/s at 15 Hz.
- `adaptiveTau(speed)` — 1€-filter style: heavy (200 ms) when still, light (45 ms) when panning, with a **deadband** so sensor noise on a motionless phone doesn't lighten the filter exactly when it should be heaviest. Constants tuned by simulation; don't nudge them without re-running those tests.
- `smoothingTau(speed, sensorPeriod)` — floors tau at the sensor interval, so a 15 Hz stream glides between samples instead of doing settle-jump-settle.

Measured against the old filter: held-still jitter ~3–4× lower (worst-case single-frame jump 1.66 px → 0.42 px at 60 Hz), 15 Hz panning ~9× smoother *and* lower lag, at the cost of ~0.5° more lag while actively panning at 60 Hz. Deliberately NOT built: motion prediction/extrapolation between samples — it would close the last of the 15 Hz sampling ripple, but overshoot is a worse artifact than ripple.

iOS compass fusion now **fades out** between ~44° and ~60° of view altitude instead of switching off at a hard 60° threshold (the hard cut put a visible jump right where people tilt up), and converges on a ~0.7 s time constant. The zenith regression test in `tests/armath.test.mjs` must stay green through any smoothing change.

## Roadmap (Phases 1–3 shipped; AR motion filtering reworked — see above)

**Sky map / AR view.** Plan agreed 2026-08-01; all three phases are now live.

- **Phase 1 — SHIPPED (2026-08-01)** — "Sky" tab, touch-drag panorama: bright-star catalog as static JSON (1,637 stars, mag ≤ 5, HYG-derived) + 150 constellation-figure polylines (borders deliberately excluded); canvas 2D gnomonic projection around a view direction; drag to look around; stars/planets/moon/sun plotted for the **scrubbed hour** (reuse `astro.js` — added an azimuth counterpart to `altitudeOf`). Works on desktop too. `data/sky.json` is generated by `node tools/build-sky-data.mjs` (checked in; regenerate only to change magnitude/name cutoffs).
- **Phase 2 — SHIPPED (2026-08-01; field fixes 08-03: roll sign, zenith basis smoothing, AR default-on; motion feel fixed 08-08)** — AR mode on that view: `DeviceOrientationEvent` drives the view direction (iOS needs `requestPermission()` in a user gesture; Android needs `deviceorientationabsolute`); rotation-matrix conversion (`js/armath.js`) + screen-orientation compensation + filtering (reworked 2026-08-08, see above); compass gives magnetic north — corrected to true north via a full WMM2025 spherical-harmonic model in JS (`js/wmm.js` + `js/wmmcof.js`, owner-ratified upgrade over a static declination table, since the error is ~13° in NYC and breaks star identification); optional `getUserMedia` camera passthrough toggle. WMM coefficients regenerate via `node tools/build-wmm.mjs` when WMM2030 releases (late 2029). Sensors cannot be tested headless, but synthetic `DeviceOrientationEvent` dispatches do exercise the whole pipeline (see the browser-verification note below).
- **Phase 3 — SHIPPED (2026-08-08)** — visual + interaction overhaul: true star colours from B−V, bright-star glow sprites and flares, atmospheric extinction, an altitude-sampled sky gradient with a directional twilight bloom and Bortle-driven horizon glow, a real ground plane, the Milky Way, constellation names, moon-phase rendering, tap-to-identify with an info card, drag inertia, keyboard control, a north-reset button and an alt/az grid toggle. Render cost measured at ~1.1 ms/frame worst case (400×630, Milky Way in view).

**Small deferred polish — SHIPPED 2026-08-07** (label dedupe, deltaY-scaled wheel zoom, roll-aware star-cull margin, alt-clamp dedupe). The flagged `wmm.declination` pole NaN was **disproven** — floating-point `cos(π/2)` ≈ 6e-17 keeps every division finite; a regression test in `tests/wmm.test.mjs` locks finite output at ±90° with no clamp needed.

**Deliberately out of scope** (owner-ratified): push notifications & cross-device sync (need a server), ISS passes (needs a real SGP4 propagator; wrong pass times are worse than none), i18n / 24-hour clock, manual Bortle override (light pollution is measured-only by design), constellation borders, deep-sky object catalogs, AR motion prediction. **AR/WMM design choices, not bugs — don't "fix" these:** WMM declination is computed at sea level only, no altitude input (compass noise dwarfs the difference from real elevation); sensor fusion is single-stage low-pass only, no Kalman filter; AR/camera state (mode, camera on/off) does not persist across sessions.

Remaining Phase 3 candidate (not yet built): object search / "point me at X" goto arrows.
