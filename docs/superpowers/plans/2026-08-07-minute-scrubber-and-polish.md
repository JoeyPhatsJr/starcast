# Minute Scrubber + Polish Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two PRs: (A) the five owner-ratified polish fixes; (B) minute-level timeline scrubbing with interpolated values and a sky-gradient strip (black night → purple twilight → blue day) with a slim hourly score bar.

**Architecture:** Pure static site, no build step. All new pure logic goes in DOM-free modules (`logic.js`, `skymap.js`, `wmm.js`, generator) covered by `node --test`; `app.js`/`ui.js` only get glue. `getSelectedHour(state)` in ui.js is the single accessor for the scrubbed record — interpolation happens there and nowhere else.

**Tech Stack:** Vanilla ES modules, Node built-in test runner, CSS custom properties.

## Global Constraints

- No dependencies, no build step, no CDN, relative paths only (CLAUDE.md hard rules).
- Bump `VERSION` in `sw.js` in ANY commit series touching `index.html`/`css/`/`js/` — CI fails the main-push otherwise. Current: `starcast-v14`. PR A → `starcast-v15`, PR B → `starcast-v16`.
- Merge PRs with a merge commit or squash, never fast-forward (`gh pr merge N --merge --delete-branch`).
- Night mode: any hardcoded blue/white in new CSS is a light leak — new colors must be CSS vars redefined under `body.night`.
- `savePrefs()` allowlist gotcha does not apply (no new prefs in this work).
- Run `npm test` before every commit claim; `node --check` any edited JS module.

---

## PR A — polish batch (branch `polish` off `main`)

### Task A1: wmm declination pole clamp

**Files:**
- Modify: `js/wmm.js:24` (top of `declination`)
- Test: `tests/wmm.test.mjs`

**Interfaces:**
- Produces: `declination(latDeg, lonDeg, decYear)` now finite for latDeg = ±90.

- [ ] **Step 1: Write the failing test** — append to `tests/wmm.test.mjs`:

```js
test('declination is finite at the exact poles', () => {
  assert.ok(Number.isFinite(declination(90, 0, 2026.5)));
  assert.ok(Number.isFinite(declination(-90, 45, 2026.5)));
});
```

(Match the file's existing import style for `test`/`assert`/`declination` — read the top of the file first.)

- [ ] **Step 2: Run to verify it fails**: `node --test tests/wmm.test.mjs` → expect FAIL (NaN at pole).
- [ ] **Step 3: Implement** — first line inside `declination(...)` body in `js/wmm.js`:

```js
  latDeg = Math.max(-89.995, Math.min(89.995, latDeg)); // exact pole → NaN in the geodetic rotation
```

- [ ] **Step 4: Run**: `node --test tests/wmm.test.mjs` → PASS.
- [ ] **Step 5: Commit**: `git add js/wmm.js tests/wmm.test.mjs && git commit -m "fix(wmm): clamp latitude away from exact poles (NaN)"`

### Task A2: dedupe near-coincident star labels (α Cen) + regen sky.json

**Files:**
- Modify: `tools/build-sky-data.mjs` (immediately after `stars.sort((a, b) => a[2] - b[2]);`)
- Regenerate: `data/sky.json` (`node tools/build-sky-data.mjs` — downloads 34MB HYG unless a local CSV path is passed; network fetch may need sandbox override)
- Test: `tests/skydata.test.mjs`

**Interfaces:**
- Produces: `data/sky.json` where no two NAMED stars are within 0.1° (keeps Mizar/Alcor at 0.197°, kills the α Cen A/B double label).

- [ ] **Step 1: Write the failing test** — append to `tests/skydata.test.mjs` (match its existing sky.json-loading style):

```js
test('no two named stars within 0.1° (double-label guard)', () => {
  const named = stars.filter((s) => s[3]);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const dDec = named[i][1] - named[j][1];
      const cosD = Math.cos((named[i][1] * Math.PI) / 180);
      let dRa = Math.abs(named[i][0] - named[j][0]);
      if (dRa > 180) dRa = 360 - dRa;
      const dist = Math.hypot(dRa * cosD, dDec);
      assert.ok(dist > 0.1, `"${named[i][3]}" and "${named[j][3]}" are ${dist.toFixed(3)}° apart`);
    }
  }
});
```

- [ ] **Step 2: Run to verify it fails**: `node --test tests/skydata.test.mjs` → FAIL naming Rigil Kentaurus/Toliman.
- [ ] **Step 3: Implement** in `tools/build-sky-data.mjs`, right after the brightest-first sort:

```js
// Drop labels (not stars) that sit within 0.1° of an already-labeled brighter
// star — α Cen A/B ("Rigil Kentaurus" + "Toliman") otherwise label twice.
// 0.1° keeps legitimately close pairs like Mizar/Alcor (0.197°).
const labeled = [];
for (const s of stars) {
  if (!s[3]) continue;
  const cosD = Math.cos((s[1] * Math.PI) / 180);
  const clash = labeled.some(([ra, dec]) => {
    let dRa = Math.abs(s[0] - ra);
    if (dRa > 180) dRa = 360 - dRa;
    return Math.hypot(dRa * cosD, s[1] - dec) <= 0.1;
  });
  if (clash) s.length = 3; // strip the name element
  else labeled.push([s[0], s[1]]);
}
```

- [ ] **Step 4: Regenerate**: `node tools/build-sky-data.mjs` (pass a local HYG CSV path if one exists; otherwise it downloads). Verify the console line still reports 1,637 stars with one fewer named.
- [ ] **Step 5: Run**: `node --test tests/skydata.test.mjs` → PASS. Also `npm test` (full suite).
- [ ] **Step 6: Commit**: `git add tools/build-sky-data.mjs data/sky.json tests/skydata.test.mjs && git commit -m "fix(sky-data): drop duplicate labels on near-coincident stars (α Cen)"`

### Task A3: scale wheel-zoom step by deltaY magnitude

**Files:**
- Modify: `js/app.js:904` (wheel handler in `wireSky`)

**Interfaces:**
- Consumes: `zoomView(sky, factor)` from skymap.js (unchanged).

- [ ] **Step 1: Implement** — replace the fixed-step line:

```js
      state.sky = zoomView(state.sky, e.deltaY < 0 ? 1.1 : 1 / 1.1);
```

with a magnitude-scaled, clamped factor (trackpads send small deltas, wheel notches ~±100):

```js
      const factor = Math.min(1.4, Math.max(1 / 1.4, Math.exp(-e.deltaY * 0.0015)));
      state.sky = zoomView(state.sky, factor);
```

- [ ] **Step 2: Verify**: `node --check js/app.js` and `npm test`.
- [ ] **Step 3: Commit**: `git add js/app.js && git commit -m "fix(sky): scale wheel-zoom step by deltaY magnitude"`

### Task A4: widen star-cull margin under roll

**Files:**
- Modify: `js/skymap.js` (`starDrawList`), `js/ui.js` (`renderSky` call site, ~line 1190)
- Test: `tests/skymap.test.mjs`

**Interfaces:**
- Produces: `starDrawList(stars, fc, view, w, h, margin = 10)` — new optional trailing param, default preserves current behavior.
- ui.js `renderSky` passes `roll ? (Math.hypot(w, h) - Math.min(w, h)) / 2 + 10 : 10` (covering-circle margin: a rotated canvas can reveal anything within the circumscribed circle of the viewport).

- [ ] **Step 1: Write the failing test** — in `tests/skymap.test.mjs`, using the file's existing fc/view fixtures, assert that a star culled at `margin = 10` survives with a large margin (pick a star projecting just outside the viewport — construct via an existing test's projection fixture; simplest: call `starDrawList` twice with margins 10 and 400 on the full catalog fixture and assert the 400-margin list is strictly longer).

```js
test('starDrawList margin widens the cull window', () => {
  const tight = starDrawList(stars, fc, view, 300, 500, 10);
  const wide = starDrawList(stars, fc, view, 300, 500, 400);
  assert.ok(wide.length > tight.length);
});
```

- [ ] **Step 2: Run to verify it fails**: `node --test tests/skymap.test.mjs` → FAIL (6th arg ignored → equal lengths).
- [ ] **Step 3: Implement** in `js/skymap.js`:

```js
export function starDrawList(stars, fc, view, w, h, margin = 10) {
  const out = [];
  for (const s of stars) {
    const { alt, az } = starHorizontal(s[0], s[1], fc);
    if (alt < -0.5) continue;
    const p = project(az, alt, view, w, h);
    if (!p || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;
    out.push({ x: p.x, y: p.y, r: magToRadius(s[2]), name: s[3] || null });
  }
  return out;
}
```

In `js/ui.js` `renderSky`, before the draw loops (roll is already computed there):

```js
  const cullMargin = roll ? (Math.hypot(w, h) - Math.min(w, h)) / 2 + 10 : 10;
```

and pass it: `starDrawList(state.skyData.stars, fc, view, w, h, cullMargin)`.

- [ ] **Step 4: Run**: `node --test tests/skymap.test.mjs`, `node --check js/ui.js` → PASS.
- [ ] **Step 5: Commit**: `git add js/skymap.js js/ui.js tests/skymap.test.mjs && git commit -m "fix(ar): widen star-cull margin under roll (corner pop-in)"`

### Task A5: dedupe alt-clamp literals

**Files:**
- Modify: `js/app.js:967` (`onOrientation`) and the skymap import at `js/app.js:17`

**Interfaces:**
- Consumes: `ALT_MIN`/`ALT_MAX` already exported by `js/skymap.js` (−30 / 89).

- [ ] **Step 1: Implement** — extend the import:

```js
import { dragView, zoomView, ALT_MIN, ALT_MAX } from './skymap.js';
```

and replace the literal clamp in `onOrientation`:

```js
    alt: Math.max(ALT_MIN, Math.min(ALT_MAX, v.alt)),
```

(Behavior note: upper bound tightens 90 → 89, matching what `dragView` already enforces — this is the point of the dedupe.)

- [ ] **Step 2: Verify**: `node --check js/app.js` && `npm test` (zenith regression test in armath.test.mjs MUST stay green).
- [ ] **Step 3: Commit**: `git add js/app.js && git commit -m "refactor(ar): use skymap ALT_MIN/ALT_MAX for orientation alt clamp"`

### Task A6: SW bump, CLAUDE.md, PR, merge

- [ ] **Step 1**: `sw.js`: `const VERSION = 'starcast-v15';`
- [ ] **Step 2**: CLAUDE.md: delete the now-done items from the "Small deferred polish" paragraph (all five are done → replace the paragraph with a note that the polish batch shipped 2026-08-07).
- [ ] **Step 3**: `npm test` → all green. Commit: `git add sw.js CLAUDE.md && git commit -m "chore: bump SW to v15; CLAUDE.md polish list done"`
- [ ] **Step 4**: `git push -u origin polish && gh pr create --title "Polish batch: label dedupe, wheel zoom, pole clamp, cull margin, clamp dedupe" --body "..."` (body lists the five fixes; end with the Claude Code attribution line).
- [ ] **Step 5**: Wait for CI green (`gh pr checks --watch`), then `gh pr merge --merge --delete-branch` (standing authorization; never FF).

---

## PR B — minute scrubber + sky-gradient strip (branch `minute-scrub` off updated `main`)

### Task B1: `interpolateHours` pure function

**Files:**
- Modify: `js/logic.js` (new export)
- Test: `tests/logic.test.mjs`

**Interfaces:**
- Produces: `interpolateHours(a, b, frac)` → new record object. `b` may be null/undefined (forecast end) → values are `a`'s, but `time` still advances. `time` is ALWAYS `a.time + frac * 3600000` (hour records are exactly 3600s apart — epochs are true UTC instants). `score` is never set — callers rescore. Numeric fields finite in both lerp; finite in one → that side; non-numeric (booleans/arrays/strings) and the categorical set `weatherCode`, `isDay` → nearest (`frac < 0.5` → a else b).

- [ ] **Step 1: Write the failing tests** — append to `tests/logic.test.mjs` (match its import style):

```js
test('interpolateHours lerps numerics, snaps categoricals, computes exact time', () => {
  const a = { time: 1000 * 3600e3, cloud: 40, windMph: 10, weatherCode: 2, isDay: 0,
              planets: ['V'], moonWaxing: true, seeingIsEstimate: true, score: 0.9 };
  const b = { time: 1001 * 3600e3, cloud: 60, windMph: 20, weatherCode: 3, isDay: 1,
              planets: ['V', 'J'], moonWaxing: true, seeingIsEstimate: true, score: 0.1 };
  const h = interpolateHours(a, b, 0.25);
  assert.equal(h.cloud, 45);
  assert.equal(h.windMph, 12.5);
  assert.equal(h.time, a.time + 0.25 * 3600e3);
  assert.equal(h.weatherCode, 2);          // nearest at 0.25 → a
  assert.deepEqual(h.planets, ['V']);
  assert.equal(interpolateHours(a, b, 0.75).weatherCode, 3); // nearest → b
  assert.equal(h.score, undefined);        // caller rescores
});

test('interpolateHours: frac 0/1 identity on numerics', () => {
  const a = { time: 0, cloud: 40 }, b = { time: 3600e3, cloud: 60 };
  assert.equal(interpolateHours(a, b, 0).cloud, 40);
  assert.equal(interpolateHours(a, b, 1).cloud, 60);
});

test('interpolateHours: one-sided and missing fields never produce NaN', () => {
  const a = { time: 0, cloud: 40, kp: 3 };           // kp only on a
  const b = { time: 3600e3, cloud: 60, aod: 0.2 };   // aod only on b
  const h = interpolateHours(a, b, 0.5);
  assert.equal(h.kp, 3);
  assert.equal(h.aod, 0.2);
  for (const v of Object.values(h)) assert.ok(typeof v !== 'number' || Number.isFinite(v));
});

test('interpolateHours clamps at forecast end (no b)', () => {
  const a = { time: 0, cloud: 40, weatherCode: 2 };
  const h = interpolateHours(a, null, 0.5);
  assert.equal(h.cloud, 40);
  assert.equal(h.weatherCode, 2);
  assert.equal(h.time, 0.5 * 3600e3);      // clock still advances
});
```

- [ ] **Step 2: Run to verify FAIL**: `node --test tests/logic.test.mjs` → "interpolateHours is not defined" (add it to the import line first so the failure is the missing export, not the missing import).
- [ ] **Step 3: Implement** in `js/logic.js`:

```js
/* Synthesize a record between two consecutive hour records for minute-level
 * scrubbing. Numeric fields lerp (generically — future side-channel fields
 * interpolate for free); categoricals and non-numerics snap to the nearest
 * hour; fields present on one side only take that side. `score` is omitted —
 * callers rescore on the lerped canonical values. `b` may be null at the
 * forecast end: values clamp to `a` but `time` still advances by frac·1h. */
const INTERP_CATEGORICAL = new Set(['weatherCode', 'isDay', 'time', 'score']);
export function interpolateHours(a, b, frac) {
  if (!b) b = a;
  const nearest = frac < 0.5 ? a : b;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (INTERP_CATEGORICAL.has(k)) { out[k] = nearest[k]; continue; }
    const av = a[k], bv = b[k];
    const aNum = typeof av === 'number' && Number.isFinite(av);
    const bNum = typeof bv === 'number' && Number.isFinite(bv);
    if (aNum && bNum) out[k] = av + (bv - av) * frac;
    else if (aNum && (bv == null || Number.isNaN(bv))) out[k] = av;
    else if (bNum && (av == null || Number.isNaN(av))) out[k] = bv;
    else out[k] = nearest[k];
  }
  out.time = a.time + frac * 3600000;
  delete out.score;
  return out;
}
```

- [ ] **Step 4: Run**: `node --test tests/logic.test.mjs` → PASS.
- [ ] **Step 5: Commit**: `git add js/logic.js tests/logic.test.mjs && git commit -m "feat(logic): interpolateHours for minute-level scrubbing"`

### Task B2: interpolating `getSelectedHour`

**Files:**
- Modify: `js/ui.js:57` (`getSelectedHour`) + its score.js import line (`js/ui.js:8`) + logic.js import line (`js/ui.js:11`)

**Interfaces:**
- Consumes: `interpolateHours` (Task B1); `overallScore` from score.js; `state.selectedMinute` (integer 0–59, may be undefined pre-Task-B3 → treat falsy as 0).
- Produces: `getSelectedHour(state)` unchanged signature; returns the raw record when minute is 0 (zero-cost path), else a synthesized record WITH a recomputed `score`.

- [ ] **Step 1: Implement**:

```js
import { scoreMetric, verdict, band, WEIGHTS, overallScore } from './score.js';
import { nightHoursOf, bestWindowIn, dewRiskStart, interpolateHours } from './logic.js';

export function getSelectedHour(state) {
  const day = state.days[state.selectedDay];
  if (!day || !day.hourIndices.length) return null;
  const pos = Math.min(state.selectedHour, day.hourIndices.length - 1);
  const gi = day.hourIndices[pos];
  const a = state.hours[gi];
  const minute = state.selectedMinute || 0;
  if (!minute) return a;
  // Global successor — crosses day/DST boundaries; null at forecast end (clamps).
  const h = interpolateHours(a, state.hours[gi + 1] || null, minute / 60);
  h.score = overallScore(h, {
    bortle: state.prefs.bortle,
    moonAltitude: h.moonAlt,
    sunAltitude: h.sunAlt,
    moonIllum: h.moonIllum,
  });
  return h;
}
```

- [ ] **Step 2: Verify**: `node --check js/ui.js` && `npm test`.
- [ ] **Step 3: Commit**: `git add js/ui.js && git commit -m "feat(ui): getSelectedHour interpolates at minute resolution"`

### Task B3: minute-level selection state + pointer math

**Files:**
- Modify: `js/app.js` — state init (~line 37), boot current-hour selection (~line 358), `setHour` (~542), `setDay` (~553), `wireTimeline` (~565)

**Interfaces:**
- Produces: `state.selectedMinute` (int 0–59); `setHour(pos, minute = 0)`.
- Consumes: `UI.updatePlayhead` re-render via existing `renderSelection()`/`renderSelectionExtras()`.

- [ ] **Step 1: Implement** — state init: add `selectedMinute: 0,` after `selectedHour: 0,`.

Boot selection (where `state.selectedHour = pos >= 0 ? pos : 0;` is set, ~line 358): after that line add — minute-of-record from the epoch delta, NOT wall-clock minutes (tz offsets can be :30/:45):

```js
  const cur = pos >= 0 ? state.hours[day.hourIndices[pos]] : null;
  state.selectedMinute = cur ? Math.max(0, Math.min(59, Math.floor((Date.now() - cur.time) / 60000))) : 0;
```

(`day` here is whatever local variable that block resolves the selected day with — adapt to the surrounding code, it locates today's hour index the same way.)

`setHour`:

```js
function setHour(pos, minute = 0) {
  if (!Number.isFinite(pos)) return; // e.g. a scrub computed against a hidden strip
  const day = state.days[state.selectedDay];
  if (!day) return;
  const clamped = Math.max(0, Math.min(day.hourIndices.length - 1, pos));
  const m = Math.max(0, Math.min(59, Math.floor(minute)));
  if (clamped === state.selectedHour && m === state.selectedMinute) return;
  state.selectedHour = clamped;
  state.selectedMinute = m;
  renderSelection();
  renderSelectionExtras();
}
```

`setDay`: keep both across days (only the hour needs clamping, minute is always valid):

```js
  state.selectedHour = Math.min(state.selectedHour, state.days[i].hourIndices.length - 1);
```

(unchanged line — no minute reset; nothing to add here, just don't zero it.)

`wireTimeline` — replace `hourFromEvent` with minute-resolution math and thread it through:

```js
  const scrubFromEvent = (e) => {
    const day = state.days[state.selectedDay];
    if (!day) return null;
    const rect = strip.getBoundingClientRect();
    const n = day.hourIndices.length;
    const t = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width)) * n * 60;
    return { pos: Math.floor(t / 60), minute: Math.floor(t % 60) };
  };
```

pointerdown/pointermove: `const s = scrubFromEvent(e); if (s) setHour(s.pos, s.minute);`

Keyboard (whole-hour steps, minute resets to 0 via the default param):

```js
    if (e.key === 'ArrowLeft') { setHour(state.selectedHour - (state.selectedMinute ? 0 : 1)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setHour(state.selectedHour + 1); e.preventDefault(); }
```

(ArrowLeft from a mid-hour position first snaps back to the top of the current hour — matches scrubber conventions.)

- [ ] **Step 2: Verify**: `node --check js/app.js` && `npm test`.
- [ ] **Step 3: Commit**: `git add js/app.js && git commit -m "feat(app): minute-resolution scrub state and pointer math"`

### Task B4: continuous playhead + minute a11y

**Files:**
- Modify: `js/ui.js` (`updatePlayhead`, `renderTimelineSegments` aria line), `index.html:62` (strip attrs)

**Interfaces:**
- Consumes: `state.selectedMinute`, interpolating `getSelectedHour` (B2).

- [ ] **Step 1: Implement** `updatePlayhead`:

```js
export function updatePlayhead(state) {
  const day = state.days[state.selectedDay];
  if (!day || !day.hourIndices.length) return;
  const n = day.hourIndices.length;
  const pos = Math.min(state.selectedHour, n - 1);
  const minute = state.selectedMinute || 0;
  const playhead = $('playhead');
  playhead.style.left = `${(((pos + minute / 60) / n) * 100)}%`;
  playhead.classList.remove('hidden');
  const h = getSelectedHour(state);
  const label = fmtTime(h.time, state.prefs.tz);
  $('timeline-label').textContent = `▾ ${label}`;
  const strip = $('timeline-strip');
  strip.setAttribute('aria-valuenow', String(pos * 60 + minute));
  strip.setAttribute('aria-valuetext', label);
}
```

(Position is now exact — a whole hour sits at its segment's left edge, not centered; centering would make the playhead jump backward when a drag crosses minute 0.)

In `renderTimelineSegments`, the aria line becomes minutes: `strip.setAttribute('aria-valuemax', String(day.hourIndices.length * 60 - 1));`

In `index.html`, the strip div: `aria-valuemax="1439"` (24h default before data lands; JS corrects on DST days).

- [ ] **Step 2: Verify**: `node --check js/ui.js` && `npm test`.
- [ ] **Step 3: Commit**: `git add js/ui.js index.html && git commit -m "feat(ui): continuous playhead, minute-level slider semantics"`

### Task B5: sky-gradient strip + slim score bar

**Files:**
- Modify: `js/ui.js` (`renderTimelineSegments`), `css/style.css` (`:root` vars, `.seg` rules, night-mode section)

**Interfaces:**
- Consumes: `state.hours[idx].sunAlt` (already computed for every hour in `buildData`).

- [ ] **Step 1: Implement gradient + drop daylight overlay** in `renderTimelineSegments` — seg creation loses the `daylight` class; add gradient build before `updatePlayhead(state)`:

```js
  for (const idx of day.hourIndices) {
    const h = state.hours[idx];
    const seg = document.createElement('div');
    seg.className = `seg band-${band(h.score)}`;
    strip.insertBefore(seg, playhead);
  }
  // Sun-altitude sky gradient: night black → twilight purple → day blue.
  // Anchor colors are CSS vars so night mode re-ramps them to red (no leak).
  const n = day.hourIndices.length;
  const stops = day.hourIndices.map((idx, i) => {
    const alt = state.hours[idx].sunAlt;
    const c = alt >= 0 ? 'var(--sky-dayc)' : alt > -18 ? 'var(--sky-twic)' : 'var(--sky-nightc)';
    return `${c} ${(((i + 0.5) / n) * 100).toFixed(1)}%`;
  });
  strip.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
```

- [ ] **Step 2: CSS** — in `css/style.css`:

Add to `:root` (the variable block near the top):

```css
  --sky-nightc: #04060d;
  --sky-twic: #453a6d;
  --sky-dayc: #2f5f9e;
```

Replace the `.seg` block (delete `.seg.daylight` entirely):

```css
.seg { flex: 1; align-self: flex-end; height: 30%; opacity: 0.95; }
.seg.band-good { background: var(--good); }
.seg.band-marginal { background: var(--marginal); }
.seg.band-bad { background: var(--bad); }
```

In the night-mode section (after the existing `body.night` palette overrides, keeping the cb-before-night ordering):

```css
body.night {
  --sky-nightc: #000;
  --sky-twic: #2a0a06;
  --sky-dayc: #571711;
}
```

(Also delete the `body.night` `.seg` opacity override at style.css:1260 only if it conflicts — check; `opacity: 0.95` matching is fine to leave.)

- [ ] **Step 3: Verify**: `npm test`; then visual check in Task B7 (day/twilight/night bands, night mode shows NO blue/purple — reds only).
- [ ] **Step 4: Commit**: `git add js/ui.js css/style.css && git commit -m "feat(timeline): sun-altitude sky gradient with slim score bar"`

### Task B6: SW bump + CLAUDE.md

- [ ] **Step 1**: `sw.js`: `const VERSION = 'starcast-v16';`
- [ ] **Step 2**: CLAUDE.md: in the Architecture/Data-flow section, note the timeline is minute-resolution: one sentence in the scrubber-adjacent prose — "The timeline scrubs at minute resolution: `getSelectedHour` interpolates between bracketing hour records (`logic.js#interpolateHours` — numerics lerp, categoricals snap to nearest) and rescores; the strip background is a per-hour sun-altitude sky gradient (`--sky-*c` vars, night-mode red-ramped) with the hourly score bar along the bottom edge."
- [ ] **Step 3**: `npm test` → green. Commit: `git add sw.js CLAUDE.md && git commit -m "chore: bump SW to v16; document minute scrubber"`

### Task B7: browser verification (Playwright MCP against local server)

Dev-loop gotcha (CLAUDE.md): unregister the SW + clear CacheStorage or disable HTTP cache, or you WILL test stale code.

- [ ] **Step 1**: `python3 -m http.server` (background) in repo root; open `http://localhost:8000` via Playwright; clear SW/caches (`navigator.serviceWorker.getRegistrations()` → unregister; `caches.keys()` → delete) then hard reload.
- [ ] **Step 2**: Verify: zero console errors; strip shows gradient (computed `background` contains `linear-gradient`); segments are bottom-aligned slim bars; playhead label shows a minutes time (e.g. "▾ 9:2x PM") on load.
- [ ] **Step 3**: Drag with real CDP mouse input (synthetic PointerEvent can't satisfy `setPointerCapture`): press at 30% strip width, move to 60%, verify label minutes change continuously and banner/tiles update, no console errors.
- [ ] **Step 4**: Toggle night mode (Settings), re-check the strip: computed background must contain NO blue (`#2f5f9e`) — reds/black only. Toggle back.
- [ ] **Step 5**: Keyboard: focus strip, ArrowRight/ArrowLeft step whole hours, minute resets to 0.

### Task B8: PR + merge

- [ ] **Step 1**: `git push -u origin minute-scrub && gh pr create --title "Minute-level scrubber + sky-gradient timeline" --body "..."` (body: interpolation design, gradient design, a11y change, test coverage; end with the Claude Code attribution).
- [ ] **Step 2**: `gh pr checks --watch` → green → `gh pr merge --merge --delete-branch`.
- [ ] **Step 3**: After ~a minute, spot-check https://joeyphatsjr.github.io/starcast/ (Playwright, fresh context) — gradient present, scrub works.
