# Design: minute-level scrubber + sky-gradient strip + polish batch

Date: 2026-08-07 · Status: approved by owner (conversation, 08-06/08-07)

## Scope

Two PRs against `main`:

1. **PR A — polish batch**: the five review-flagged items from CLAUDE.md.
2. **PR B — minute-level scrubber**: continuous (per-minute) timeline scrubbing with
   interpolated values, plus a redesigned strip: sun-altitude sky gradient background
   with a slim hourly score bar at the bottom edge.

## PR A — polish batch (owner-ratified list, no design decisions open)

1. `tools/build-sky-data.mjs`: dedupe near-coincident star labels (α Cen is labeled
   twice: "Rigil Kentaurus" + "Toliman"); regenerate `data/sky.json`.
2. `js/app.js` `wireSky()`: scale wheel-zoom step by `deltaY` magnitude.
3. `js/wmm.js` `declination()`: clamp latitude away from ±90° (NaN at exact pole).
   Node-testable; add regression test.
4. `js/skymap.js`: widen the star-cull margin under roll (corner pop-in during AR).
5. Dedupe the alt-clamp literals in `onOrientation` (app.js) vs skymap's
   `ALT_MIN/MAX` — one source of truth, exported from skymap.
6. SW `VERSION` bump.

## PR B — minute-level scrubber

### Selection state

- Add `state.selectedMinute` (integer 0–59) alongside the existing `selectedHour`
  day-relative index. Boot selects current hour **and minute**; day switches preserve
  both; manual jumps by tap snap to the tapped minute.
- Keyboard on the strip keeps whole-hour steps (ArrowLeft/Right) and resets
  `selectedMinute` to 0 — coarse, predictable a11y.

### Pointer math (`wireTimeline` in app.js)

- Drag/tap maps strip x-fraction → total minutes across the day (`n_hours × 60`),
  snapped to whole minutes. Playhead positions continuously:
  `left = (hourIdx + minute/60) / n`. Label shows exact time ("▾ 9:23 PM").
- Strip slider a11y moves to minute units: `aria-valuemax = n×60 − 1`,
  `aria-valuenow` in minutes, `aria-valuetext` = formatted time.

### Interpolation — new pure function in `logic.js`

`interpolateHours(a, b, frac)` → synthesized record:

- **Generic numeric lerp** over keys finite in both records (auto-covers future
  side-channel fields: AOD, Kp, `w250`/`w500`, canonical `windMph`/`apparentF`/
  `visMiles`, seeing/transparency, sunAlt/moonAlt/moonIllum).
- **Categorical set takes nearest-hour** (frac < 0.5 → a, else b): `weatherCode`,
  `isDay`, `planets`, `moonWaxing`, and all non-numeric values (booleans/arrays/
  strings) generically.
- Fields finite in only one record take the available side (side-channel patch
  landed for one hour only) — no NaN leaks.
- `time` = exact interpolated epoch; `score` excluded — caller rescores.

### Wiring (single choke point)

- `getSelectedHour(state)` in ui.js returns the interpolated record:
  bracket = `hours[globalIdx]` / `hours[globalIdx + 1]` (global indices — day
  boundaries and DST 23/25-hour days work for free; final forecast hour clamps,
  no extrapolation). Rescore via `overallScore` on lerped canonicals so the
  verdict banner slides smoothly through band transitions.
- Sky tab reads the selected record's `time` → minute-exact ephemeris for free.
- LIVE ribbon logic unchanged (selected hour == current hour).

### Strip redesign — sky gradient + slim score bar (owner-picked "split" layout)

- **Background**: a CSS `linear-gradient(90deg, …)` built in JS from per-hour
  `sunAlt` samples (plus midpoints for smoother fades). Color per stop maps sun
  altitude: ≥ 0° → day blue; −18°–0° → twilight purple blend; ≤ −18° → night
  black. Anchor colors are **CSS variables** (`--sky-night`, `--sky-twilight-c`,
  `--sky-day-c`) referenced inside the inline gradient so `body.night` can
  redefine them to the red-luminance ramp — no night-mode light leak (hard
  CLAUDE.md rule). Blending between anchors uses gradient stop interpolation
  (adjacent stops fade naturally); no color-mix needed.
- **Score bar**: the existing hourly segments shrink to a slim (~25% height) bar
  anchored to the strip's bottom edge, keeping `band-good/-marginal/-bad`
  classes. The flat 35% black daylight overlay is removed (the gradient now
  conveys day/night). Playhead spans full strip height.
- Color-blind mode (`body.cb`) only affects band colors — unchanged; declared-
  before-night ordering preserved.

### Testing

- `tests/logic.test.mjs`: `interpolateHours` — lerp correctness, frac 0/1
  identity, categorical nearest, one-sided fields, no-NaN guarantee.
- Existing tests stay green (`npm test`).
- Playwright against `python3 -m http.server` (SW unregistered, caches cleared):
  drag via real CDP mouse input (synthetic PointerEvents can't satisfy
  `setPointerCapture`), verify minute label updates + gradient present + night
  mode shows no blue.
- SW `VERSION` bump (CI-enforced).

## Out of scope

- Minute-level *data* (Open-Meteo minutely_15 exists for some regions but adds a
  second fetch + partial coverage — not worth it; interpolation is honest enough
  for a glance dashboard).
- Charts stay hourly.
