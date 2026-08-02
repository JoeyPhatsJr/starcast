# Sky Map Phase 1 ("Sky" tab, touch-drag panorama) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new "Sky" bottom-nav tab showing a drag/pinch canvas panorama of stars (mag ≤ 5), all 88 constellation line figures, sun, moon, and planets for the currently scrubbed hour at the user's location.

**Architecture:** All new math lives in pure, Node-testable modules: `js/astro.js` gains an azimuth counterpart to `altitudeOf` plus a `skyBodies()` accessor exposing the RA/Dec currently discarded inside private helpers; a new `js/skymap.js` holds view-state math, gnomonic projection, and draw-list builders. `js/ui.js` gets a dumb `renderSky(state)` that only executes draw lists onto a canvas; `js/app.js` wires the route, lazy catalog fetch, and pointer gestures. Star/line data is a checked-in static JSON generated once by `tools/build-sky-data.mjs`.

**Tech Stack:** Vanilla ES modules, Canvas 2D, `node --test`. Zero runtime dependencies (hard constraint).

## Global Constraints

- Pure static site: no build step, no npm dependencies, no CDN scripts, no API keys. `package.json` must not gain dependencies.
- All asset paths relative (`./data/sky.json`, never `/data/...`) — site serves from `/starcast/` subpath.
- Bump `VERSION` in `sw.js` (currently `starcast-v10` at sw.js:10) in the same change set as any edit to `index.html`, `css/`, `js/`, `manifest.webmanifest` — CI fails otherwise. New JS files AND `data/sky.json` go into the SW `SHELL` array (a 404 on any SHELL entry fails the whole SW install, so the file must exist first).
- `astro.js` conventions: angles in DEGREES at the API boundary, east-positive longitudes, no refraction, ±1° accuracy budget ("don't chase arcminutes").
- Pure logic goes in Node-importable modules (`astro.js`, `skymap.js`), never inline in `app.js`/`ui.js`.
- Night mode: no hardcoded blue/white in new **CSS** (use vars). Canvas hex colors are fine (like charts) because the canvas gets red-filtered by the `body.night` CSS filter — the new canvas must be added to that filter's selector list at `css/style.css:1063`.
- New CSS rules must be appended AFTER the "APPLE WEATHER THEME" section (css/style.css:1156→EOF) or they'll be overridden.
- All display times use `state.prefs.tz` (Open-Meteo's IANA zone) via `Intl.DateTimeFormat` — never the browser timezone.
- The canvas needs `touch-action: none` (not `manipulation`) — it owns all gestures.
- Git note: repo may be in detached HEAD. Start by branching: `git checkout main && git pull && git checkout -b sky-map-phase1`.

## Locked design decisions (owner-ratified 2026-08-01)

- Sky is a **6th nav tab**, placed right after Conditions.
- **All 88** constellation figures, from d3-celestial line data (BSD-3, coordinates are raw RA/Dec — no star-ID matching). Figures ONLY — constellation *borders* (constellations.borders.json) are explicitly out of scope (owner ruling 2026-08-01).
- Labels: sun/moon/planets always; star names only for mag ≤ 1.6 **plus Polaris** (~20 names, stored in the catalog file).
- Drag + **pinch zoom** (and desktop scroll-wheel), FOV clamped 30°–100° (gnomonic projection degrades beyond that).
- Time source: the scrubbed hour (`getSelectedHour(state).time`, epoch ms). Scrubbing on the Conditions tab and returning to Sky shows that hour; falls back to `new Date()` if no data yet.
- Initial view: az 180 (south), alt 25, fov 70. View state is ephemeral (not persisted).
- Objects below alt −0.5° are not drawn (no ground-fill polygon in Phase 1 — just the horizon line + cardinal labels).
- Canvas background gradient keys off sun altitude (day / twilight / night), mirroring the `body.sky-day`/`sky-twilight` precedent.

## Integration map (verified file:line, pre-change)

- Route table `ROUTES`: `js/app.js:492`; `applyRoute()` js/app.js:494-503; per-route re-render lines also in `renderData()` js/app.js:369-380.
- Scrub → `setHour` js/app.js:507, `setDay` js/app.js:518, both call `renderSelection()` js/app.js:359-363.
- `getSelectedHour(state)` js/ui.js:54-59. Hour record epoch field: `time` (ms). `state.prefs.{lat,lon,tz}`.
- Nav markup: index.html:236-259 (5 items, 20×24-viewBox `currentColor` SVGs). Sections: `id="view-<route>"` + `class="view hidden"`.
- `UI.showView` js/ui.js:1117-1127 toggles `.hidden` by section id — a new `view-sky` section Just Works.
- Canvas DPR pattern to copy: `initStars()` js/ui.js:63-106.
- Night filter list: css/style.css:1063 `body.night :is(#stars, .t-icon, ...)`.
- SW: sw.js:10 `VERSION`, sw.js:13-29 `SHELL`.
- ui.js may import astro.js/skymap.js (pure); event wiring belongs in app.js.

---

### Task 1: `astro.js` — `horizontalOf()` (alt+az)

**Files:**
- Modify: `js/astro.js` (around line 51, `altitudeOf`)
- Test: `tests/astro.test.mjs` (append)

**Interfaces:**
- Consumes: existing `gmst(jd)`, `norm360`, `sin`, `cos`, `DEG`, `RAD`.
- Produces: `export function horizontalOf(ra, dec, jd, lat, lon)` → `{ alt, az }` degrees; az is compass azimuth 0=N, 90=E, 180=S. `altitudeOf` becomes a thin delegate (existing callers/tests unchanged).

- [ ] **Step 1: Write the failing tests** (append to `tests/astro.test.mjs`; add `horizontalOf` to the import list at the top). Sun-azimuth tests live in Task 2 (they go through `skyBodies`, which exposes the sun's RA/Dec); Task 1 tests use Polaris, whose J2000 coordinates are constants:

```js
/* ================= horizontalOf (alt/az) ================= */

test('Polaris sits at az≈0, alt≈latitude', () => {
  const jd = julianDate(new Date('2026-08-01T04:00:00Z'));
  const { alt, az } = horizontalOf(37.95, 89.26, jd, NYC.lat, NYC.lon); // Polaris J2000
  assert.ok(Math.abs(alt - NYC.lat) < 1.5, `alt ${alt}`);
  assert.ok(az < 2.5 || az > 357.5, `az ${az}`);
});

test('altitudeOf still matches horizontalOf.alt exactly', () => {
  const jd = julianDate(new Date('2026-03-15T02:00:00Z'));
  const alt = altitudeOf(101.29, -16.72, jd, NYC.lat, NYC.lon); // Sirius
  assert.equal(alt, horizontalOf(101.29, -16.72, jd, NYC.lat, NYC.lon).alt);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/astro.test.mjs`
Expected: FAIL — `horizontalOf` is not exported.

- [ ] **Step 3: Implement** — in `js/astro.js`, replace the body of `altitudeOf` and add `horizontalOf` beneath it:

```js
/** Altitude (degrees) of a body at (ra, dec) for an observer at lat/lon. */
export function altitudeOf(ra, dec, jd, lat, lon) {
  return horizontalOf(ra, dec, jd, lat, lon).alt;
}

/**
 * Horizontal coordinates of a body at (ra, dec): altitude plus compass
 * azimuth (0 = north, 90 = east). Azimuth comes from the standard
 * meridian-relative form, then is rotated 180° to compass convention.
 */
export function horizontalOf(ra, dec, jd, lat, lon) {
  const lst = gmst(jd) + lon; // local sidereal time, east longitude positive
  const ha = norm360(lst - ra); // hour angle
  const alt = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha)) * RAD;
  const az = norm360(
    Math.atan2(sin(ha), cos(ha) * sin(lat) - Math.tan(dec * DEG) * cos(lat)) * RAD + 180
  );
  return { alt, az };
}
```

- [ ] **Step 4: Run the full astro suite** — `node --test tests/astro.test.mjs` — every pre-existing altitude test must still pass (delegation must be exact, not approximate). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/astro.js tests/astro.test.mjs
git commit -m "feat(astro): horizontalOf() alt/az; altitudeOf delegates"
```

---

### Task 2: `astro.js` — `skyBodies()` (sun/moon/planet positions for the map)

**Files:**
- Modify: `js/astro.js` (refactor `planetAltitude` ~line 263; add `skyBodies` near the end)
- Test: `tests/astro.test.mjs` (append)

**Interfaces:**
- Consumes: `horizontalOf` (Task 1), private `eclToEq`, `sunEclipticLongitude`, `moonEcliptic`, `heliocentric`, `EARTH`, `PLANETS`.
- Produces: `export function skyBodies(date, lat, lon)` → array of 7 objects `{ kind: 'sun'|'moon'|'planet', abbr, name, ra, dec, alt, az }` (degrees; moon alt includes the −0.952·cos(alt) topocentric parallax term, same as `moonAltitude`). Order: sun, moon, then Me/V/Ma/J/S.

- [ ] **Step 1: Write the failing tests** (append; import `skyBodies`, `moonAltitude`, `visiblePlanets`)

```js
/* ================= skyBodies ================= */

test('skyBodies returns 7 finite bodies in canonical order', () => {
  const d = new Date('2026-08-01T04:00:00Z');
  const bodies = skyBodies(d, NYC.lat, NYC.lon);
  assert.equal(bodies.length, 7);
  assert.deepEqual(bodies.map((b) => b.abbr), ['Sun', 'Moon', 'Me', 'V', 'Ma', 'J', 'S']);
  for (const b of bodies) {
    for (const k of ['ra', 'dec', 'alt', 'az']) assert.ok(Number.isFinite(b[k]), `${b.abbr}.${k}`);
    assert.ok(b.az >= 0 && b.az < 360, `${b.abbr} az ${b.az}`);
  }
});

test('skyBodies moon altitude matches moonAltitude()', () => {
  const d = new Date('2026-08-01T04:00:00Z');
  const moon = skyBodies(d, NYC.lat, NYC.lon).find((b) => b.kind === 'moon');
  assert.ok(Math.abs(moon.alt - moonAltitude(d, NYC.lat, NYC.lon)) < 0.05, `${moon.alt}`);
});

test('skyBodies planets above 5° agree with visiblePlanets()', () => {
  const d = new Date('2026-08-01T04:00:00Z');
  const up = skyBodies(d, NYC.lat, NYC.lon)
    .filter((b) => b.kind === 'planet' && b.alt > 5)
    .map((b) => b.abbr);
  assert.deepEqual(up, visiblePlanets(d, NYC.lat, NYC.lon));
});

test('sun is due south at NYC solar noon and east in the morning', () => {
  const noonSun = skyBodies(new Date('2026-08-01T17:00:00Z'), NYC.lat, NYC.lon)[0];
  assert.ok(Math.abs(noonSun.az - 180) < 10, `noon az ${noonSun.az}`);
  assert.ok(noonSun.alt > 55 && noonSun.alt < 75, `noon alt ${noonSun.alt}`);
  const amSun = skyBodies(new Date('2026-08-01T10:30:00Z'), NYC.lat, NYC.lon)[0];
  assert.ok(amSun.az > 50 && amSun.az < 110, `morning az ${amSun.az}`);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/astro.test.mjs` — FAIL: `skyBodies` not exported.

- [ ] **Step 3: Implement.** First refactor the planet pipeline so RA/Dec is reusable (replace the existing `planetAltitude` at ~line 263):

```js
/** Geocentric RA/Dec (degrees) of one planet (by table index) at a JD. */
function planetEquatorial(index, jd) {
  const T = (jd - 2451545.0) / 36525;
  const earth = heliocentric(EARTH, T);
  const p = heliocentric(PLANETS[index], T);
  const x = p.x - earth.x;
  const y = p.y - earth.y;
  const z = p.z - earth.z;
  const lam = Math.atan2(y, x) * RAD;
  const bet = Math.atan2(z, Math.hypot(x, y)) * RAD;
  return eclToEq(lam, bet, jd);
}

/** Altitude in degrees of one planet (by table index) at an instant. */
function planetAltitude(index, date, lat, lon) {
  const jd = julianDate(date);
  const { ra, dec } = planetEquatorial(index, jd);
  return altitudeOf(ra, dec, jd, lat, lon);
}
```

Then add at the end of the file:

```js
/**
 * Positions of the sun, moon, and the five naked-eye planets for the sky
 * map: { kind, abbr, name, ra, dec, alt, az }, all degrees. The moon gets
 * the same topocentric parallax correction as moonAltitude().
 */
export function skyBodies(date, lat, lon) {
  const jd = julianDate(date);
  const out = [];

  const sunEq = eclToEq(sunEclipticLongitude(jd), 0, jd);
  out.push({ kind: 'sun', abbr: 'Sun', name: 'Sun', ...sunEq, ...horizontalOf(sunEq.ra, sunEq.dec, jd, lat, lon) });

  const { lam, bet } = moonEcliptic(jd);
  const moonEq = eclToEq(lam, bet, jd);
  const moonH = horizontalOf(moonEq.ra, moonEq.dec, jd, lat, lon);
  out.push({
    kind: 'moon', abbr: 'Moon', name: 'Moon', ...moonEq,
    az: moonH.az,
    alt: moonH.alt - 0.952 * cos(moonH.alt),
  });

  for (let i = 0; i < PLANETS.length; i++) {
    const eq = planetEquatorial(i, jd);
    out.push({
      kind: 'planet', abbr: PLANETS[i].abbr, name: PLANETS[i].name, ...eq,
      ...horizontalOf(eq.ra, eq.dec, jd, lat, lon),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run full suite** — `node --test tests/astro.test.mjs` — PASS (including all pre-existing planet tests, which exercise the refactored `planetAltitude`).

- [ ] **Step 5: Commit**

```bash
git add js/astro.js tests/astro.test.mjs
git commit -m "feat(astro): skyBodies() sun/moon/planet alt-az for sky map"
```

---

### Task 3: Data pipeline — `tools/build-sky-data.mjs` → `data/sky.json`

**Files:**
- Create: `tools/build-sky-data.mjs` (dev-only; NOT in SW shell, NOT loaded by the site)
- Create: `data/sky.json` (generated, checked in, ~55–65KB)
- Test: `tests/skydata.test.mjs` (new file — validates the checked-in JSON, guards future regeneration)

**Interfaces:**
- Produces `data/sky.json`: `{ "stars": [[raDeg, decDeg, mag, name?], ...], "lines": [[[raDeg, decDeg], ...], ...] }`. Stars sorted brightest-first; ra ∈ [0, 360), dec ∈ [−90, 90], mag ≤ 5; `name` (string) present only for mag ≤ 1.6 or Polaris. Lines are flattened polylines (≥2 vertices each).
- Sources: HYG v4.1 CSV (`ra` column is in **HOURS** — multiply by 15; row `id` 0 is Sol — skip) and d3-celestial GeoJSON (coordinates `[raDeg −180..180, decDeg]` — normalize RA to 0–360).

- [ ] **Step 1: Write the failing validation test** — `tests/skydata.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sky = JSON.parse(readFileSync(new URL('../data/sky.json', import.meta.url), 'utf8'));

test('star catalog has ~1600 stars, all fields in range, brightest first', () => {
  assert.ok(sky.stars.length > 1200 && sky.stars.length < 2500, `${sky.stars.length} stars`);
  let prevMag = -Infinity;
  for (const s of sky.stars) {
    assert.ok(s[0] >= 0 && s[0] < 360, `ra ${s[0]}`);
    assert.ok(s[1] >= -90 && s[1] <= 90, `dec ${s[1]}`);
    assert.ok(s[2] <= 5.05, `mag ${s[2]}`);
    assert.ok(s[2] >= prevMag, 'sorted brightest-first');
    prevMag = s[2];
  }
});

test('iconic bright stars are named', () => {
  const names = new Set(sky.stars.filter((s) => s[3]).map((s) => s[3]));
  for (const want of ['Sirius', 'Vega', 'Arcturus', 'Betelgeuse', 'Polaris']) {
    assert.ok(names.has(want), `missing ${want}`);
  }
  assert.ok(names.size >= 15 && names.size <= 40, `${names.size} named stars`);
});

test('constellation polylines cover the sky and are in range', () => {
  assert.ok(sky.lines.length > 120, `${sky.lines.length} polylines`); // lines file yields ~150 (owner ruling 2026-08-01: figures only, no borders)
  for (const line of sky.lines) {
    assert.ok(line.length >= 2);
    for (const [ra, dec] of line) {
      assert.ok(ra >= 0 && ra < 360, `line ra ${ra}`);
      assert.ok(dec >= -90 && dec <= 90, `line dec ${dec}`);
    }
  }
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/skydata.test.mjs` — FAIL (no `data/sky.json`).

- [ ] **Step 3: Write the generator** — `tools/build-sky-data.mjs`:

```js
// tools/build-sky-data.mjs — regenerate data/sky.json. Dev-only; run once and
// check the output in. Usage:
//   node tools/build-sky-data.mjs [path/to/local/hygdata.csv]
// Sources:
//   Stars: HYG v4.1 (astronexus.com) — CC BY-SA 4.0. `ra` column is in HOURS.
//   Lines: d3-celestial by Olaf Frohn — BSD-3. GeoJSON, RA degrees in -180..180.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const HYG_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';
const LINES_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json';
const MAG_LIMIT = 5.0;
const NAME_MAG_LIMIT = 1.6;
const ALWAYS_NAME = new Set(['Polaris']); // dimmer than the cutoff, but iconic

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const csv = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(HYG_URL)).text();
const rows = csv.split('\n');
const col = Object.fromEntries(splitCsvLine(rows[0]).map((h, i) => [h.trim(), i]));

const stars = [];
for (let i = 1; i < rows.length; i++) {
  const f = splitCsvLine(rows[i]);
  if (f.length < 15 || f[col.id] === '0') continue; // short row or Sol
  const mag = parseFloat(f[col.mag]);
  const raHours = parseFloat(f[col.ra]);
  const dec = parseFloat(f[col.dec]);
  if (!Number.isFinite(mag) || mag > MAG_LIMIT) continue;
  if (!Number.isFinite(raHours) || !Number.isFinite(dec)) continue;
  const star = [+(raHours * 15).toFixed(2), +dec.toFixed(2), +mag.toFixed(1)];
  const proper = (f[col.proper] || '').trim();
  if (proper && (mag <= NAME_MAG_LIMIT || ALWAYS_NAME.has(proper))) star.push(proper);
  stars.push(star);
}
stars.sort((a, b) => a[2] - b[2]); // brightest first → draw/label priority

const geo = await (await fetch(LINES_URL)).json();
const lines = [];
for (const feat of geo.features) {
  for (const seg of feat.geometry.coordinates) {
    lines.push(seg.map(([lon, lat]) => [+(((lon % 360) + 360) % 360).toFixed(1), +lat.toFixed(1)]));
  }
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/sky.json', import.meta.url), JSON.stringify({ stars, lines }));
console.log(`data/sky.json: ${stars.length} stars (${stars.filter((s) => s[3]).length} named), ${lines.length} polylines`);
```

- [ ] **Step 4: Generate** — `node tools/build-sky-data.mjs` (downloads ~34MB CSV once; a local copy may exist at the session scratchpad as `hyg.csv` — pass its path as arg 1 to skip the download). Then check size: `ls -la data/sky.json` (expect ~55–65KB) and spot-check: `node -e "const s=require('./data/sky.json'); console.log(s.stars.slice(0,3), s.lines.length)"` — first star should be Sirius (`[101.29, -16.72, -1.4, 'Sirius']`).

- [ ] **Step 5: Run the validation test** — `node --test tests/skydata.test.mjs` — PASS. Then the full suite: `npm test` — PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/build-sky-data.mjs data/sky.json tests/skydata.test.mjs
git commit -m "feat(data): bright-star + constellation-line catalog (HYG, d3-celestial)"
```

---

### Task 4: `js/skymap.js` — pure projection & view math

**Files:**
- Create: `js/skymap.js`
- Test: `tests/skymap.test.mjs`

**Interfaces:**
- Consumes: `gmst` from `./astro.js` (pure→pure import is allowed; ui.js already imports astro.js).
- Produces (all degrees in, px out):
  - `FOV_MIN = 30`, `FOV_MAX = 100`, `ALT_MIN = -30`, `ALT_MAX = 89` (exported consts)
  - `normAz(az)` → [0, 360)
  - `clampView({az, alt, fov})` → clamped copy
  - `dragView(view, dxPx, dyPx, widthPx)` → new view (sky follows the finger: drag right ⇒ az decreases; drag down ⇒ alt increases)
  - `zoomView(view, factor)` → new view (factor > 1 narrows FOV)
  - `cardinalName(az)` → `'N'|'NE'|...|'NW'`
  - `CARDINALS` → `[['N',0],['NE',45],['E',90],['SE',135],['S',180],['SW',225],['W',270],['NW',315]]`
  - `project(az, alt, view, w, h)` → `{x, y}` or `null` (behind camera)
  - `frameContext(jd, lat, lon)` → `{ lst, sinLat, cosLat }` (per-frame precompute)
  - `starHorizontal(raDeg, decDeg, fc)` → `{alt, az}` (fast path; must agree with `astro.horizontalOf`)
  - `magToRadius(mag)` → px
  - `starDrawList(stars, fc, view, w, h)` → `[{x, y, r, name|null}]` (culls alt < −0.5 and offscreen)
  - `lineDrawList(lines, fc, view, w, h)` → array of point-runs `[[{x,y},...], ...]` (each run ≥ 2 points; broken at horizon/behind-camera)
  - `horizonDrawList(view, w, h)` → same run shape, sampling alt=0 every 2° of az

- [ ] **Step 1: Write the failing tests** — `tests/skymap.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampView, dragView, zoomView, cardinalName, project,
  frameContext, starHorizontal, magToRadius, starDrawList,
  lineDrawList, horizonDrawList, FOV_MIN, FOV_MAX,
} from '../js/skymap.js';
import { julianDate, horizontalOf } from '../js/astro.js';

const VIEW = { az: 180, alt: 25, fov: 70 };
const NYC = { lat: 40.7128, lon: -74.006 };

test('view center projects to canvas center', () => {
  const p = project(180, 25, VIEW, 400, 300);
  assert.ok(Math.abs(p.x - 200) < 0.01 && Math.abs(p.y - 150) < 0.01, `${p.x},${p.y}`);
});

test('east of center is right, above center is up', () => {
  assert.ok(project(190, 25, VIEW, 400, 300).x > 200);
  assert.ok(project(180, 35, VIEW, 400, 300).y < 150);
});

test('points behind the camera are null', () => {
  assert.equal(project(0, 0, VIEW, 400, 300), null);
});

test('dragging right pans view left (az decreases); down looks up', () => {
  const v = dragView(VIEW, 50, 0, 500);
  assert.ok(v.az < 180, `az ${v.az}`);
  assert.ok(dragView(VIEW, 0, 50, 500).alt > 25);
});

test('view clamps: alt, fov bounds hold', () => {
  assert.equal(clampView({ az: -10, alt: 200, fov: 300 }).alt, 89);
  assert.equal(clampView({ az: -10, alt: 200, fov: 300 }).az, 350);
  assert.equal(zoomView(VIEW, 100).fov, FOV_MIN);
  assert.equal(zoomView(VIEW, 0.01).fov, FOV_MAX);
});

test('cardinalName rounds to nearest of 8', () => {
  assert.equal(cardinalName(359), 'N');
  assert.equal(cardinalName(44), 'NE');
  assert.equal(cardinalName(200), 'S');
});

test('starHorizontal agrees with astro.horizontalOf', () => {
  const jd = julianDate(new Date('2026-08-01T04:00:00Z'));
  const fc = frameContext(jd, NYC.lat, NYC.lon);
  const a = starHorizontal(279.23, 38.78, fc); // Vega
  const b = horizontalOf(279.23, 38.78, jd, NYC.lat, NYC.lon);
  assert.ok(Math.abs(a.alt - b.alt) < 1e-9 && Math.abs(a.az - b.az) < 1e-9);
});

test('magToRadius is monotonic decreasing and positive', () => {
  assert.ok(magToRadius(-1.4) > magToRadius(1) && magToRadius(1) > magToRadius(5));
  assert.ok(magToRadius(5) > 0.3);
});

test('draw lists cull and produce sane runs', () => {
  const jd = julianDate(new Date('2026-08-01T04:00:00Z'));
  const fc = frameContext(jd, NYC.lat, NYC.lon);
  const stars = [[279.23, 38.78, 0.0, 'Vega'], [101.29, -16.72, -1.4, 'Sirius']];
  const list = starDrawList(stars, fc, { az: 90, alt: 60, fov: 100 }, 400, 300);
  assert.ok(list.length >= 1); // Vega is high in the NYC summer sky
  for (const s of list) assert.ok(Number.isFinite(s.x) && s.r > 0);
  const runs = lineDrawList([[[279, 38], [285, 40], [290, 35]]], fc, { az: 90, alt: 60, fov: 100 }, 400, 300);
  for (const run of runs) assert.ok(run.length >= 2);
});

test('horizon is visible at alt 25 and gone looking straight up zoomed in', () => {
  assert.ok(horizonDrawList(VIEW, 400, 300).length > 0);
  assert.equal(horizonDrawList({ az: 0, alt: 89, fov: 30 }, 400, 300).length, 0);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/skymap.test.mjs` — FAIL (module missing).

- [ ] **Step 3: Implement** — `js/skymap.js`, complete file:

```js
// js/skymap.js — pure math for the Sky panorama: view state, gnomonic
// projection, and per-frame draw lists. DOM-free and Node-testable.
//
// Conventions match astro.js: degrees at the API boundary. Azimuth is
// compass azimuth (0 = N, 90 = E). The projection is gnomonic
// (rectilinear): distortion-free at center, unusable past ~110° — hence
// the FOV clamps.
import { gmst } from './astro.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const FOV_MIN = 30;
export const FOV_MAX = 100;
export const ALT_MIN = -30; // allow dipping below horizon so it can sit high on screen
export const ALT_MAX = 89;

export const CARDINALS = [
  ['N', 0], ['NE', 45], ['E', 90], ['SE', 135],
  ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
];

export function normAz(az) {
  az %= 360;
  return az < 0 ? az + 360 : az;
}

export function clampView(v) {
  return {
    az: normAz(v.az),
    alt: Math.min(ALT_MAX, Math.max(ALT_MIN, v.alt)),
    fov: Math.min(FOV_MAX, Math.max(FOV_MIN, v.fov)),
  };
}

/** Pan by a pointer delta in px — the sky follows the finger. */
export function dragView(view, dxPx, dyPx, widthPx) {
  const s = view.fov / widthPx; // degrees per pixel at current zoom
  return clampView({ az: view.az - dxPx * s, alt: view.alt + dyPx * s, fov: view.fov });
}

/** factor > 1 zooms in (narrower field of view). */
export function zoomView(view, factor) {
  return clampView({ az: view.az, alt: view.alt, fov: view.fov / factor });
}

export function cardinalName(az) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(normAz(az) / 45) % 8];
}

/**
 * Gnomonic projection of an (az, alt) direction onto a w×h canvas for a
 * given view. Returns null when the point is behind the camera (or so far
 * off-axis the projection blows up).
 */
export function project(az, alt, view, w, h) {
  const ca = Math.cos(alt * DEG);
  const x = ca * Math.sin((az - view.az) * DEG); // east-right in view frame
  const y0 = Math.sin(alt * DEG);
  const z0 = ca * Math.cos((az - view.az) * DEG);
  const cv = Math.cos(view.alt * DEG);
  const sv = Math.sin(view.alt * DEG);
  const y = y0 * cv - z0 * sv; // rotate down by the view altitude
  const z = z0 * cv + y0 * sv; // forward component
  if (z <= 0.05) return null;
  const f = w / 2 / Math.tan((view.fov / 2) * DEG);
  return { x: w / 2 + (x / z) * f, y: h / 2 - (y / z) * f };
}

/** Per-frame precompute so transforming ~1,600 stars stays cheap. */
export function frameContext(jd, lat, lon) {
  return { lst: gmst(jd) + lon, sinLat: Math.sin(lat * DEG), cosLat: Math.cos(lat * DEG) };
}

/** Fast equatorial→horizontal for catalog stars. Mirrors astro.horizontalOf. */
export function starHorizontal(ra, dec, fc) {
  const ha = (fc.lst - ra) * DEG;
  const sd = Math.sin(dec * DEG);
  const cd = Math.cos(dec * DEG);
  const alt = Math.asin(fc.sinLat * sd + fc.cosLat * cd * Math.cos(ha)) * RAD;
  const az = normAz(Math.atan2(Math.sin(ha), Math.cos(ha) * fc.sinLat - (sd / cd) * fc.cosLat) * RAD + 180);
  return { alt, az };
}

/** mag −1.5 (Sirius) ≈ 4.2px, mag 5 ≈ 0.65px. */
export function magToRadius(mag) {
  return Math.max(0.6, 3.4 - 0.55 * mag);
}

/** Screen draw list for catalog stars: culls below-horizon and offscreen. */
export function starDrawList(stars, fc, view, w, h) {
  const out = [];
  for (const s of stars) {
    const { alt, az } = starHorizontal(s[0], s[1], fc);
    if (alt < -0.5) continue;
    const p = project(az, alt, view, w, h);
    if (!p || p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) continue;
    out.push({ x: p.x, y: p.y, r: magToRadius(s[2]), name: s[3] || null });
  }
  return out;
}

/** Constellation polylines → screen point-runs, broken at horizon/behind-camera. */
export function lineDrawList(lines, fc, view, w, h) {
  const runs = [];
  for (const line of lines) {
    let run = [];
    for (const [ra, dec] of line) {
      const { alt, az } = starHorizontal(ra, dec, fc);
      const p = alt < -0.5 ? null : project(az, alt, view, w, h);
      if (p) {
        run.push(p);
      } else if (run.length) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

/** The alt=0 circle as screen point-runs (sampled every 2° of azimuth). */
export function horizonDrawList(view, w, h) {
  const runs = [];
  let run = [];
  for (let az = 0; az <= 360; az += 2) {
    const p = project(az, 0, view, w, h);
    if (p) {
      run.push(p);
    } else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
```

- [ ] **Step 4: Run** — `node --test tests/skymap.test.mjs` then `npm test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add js/skymap.js tests/skymap.test.mjs
git commit -m "feat(skymap): gnomonic projection, view math, draw lists"
```

---

### Task 5: Sky view — markup, CSS, `renderSky`, route (static render)

**Files:**
- Modify: `index.html` (nav item after Conditions; new `<section id="view-sky">` after `#view-conditions`)
- Modify: `css/style.css` (append sky rules at EOF, after the APPLE WEATHER THEME section; add `#sky-canvas` to the night filter list at line ~1063)
- Modify: `js/ui.js` (add `renderSky(state)`; extend astro import; import skymap)
- Modify: `js/app.js` (route entry, `ensureSkyData()`, render hookups)

**Interfaces:**
- Consumes: `skyBodies`, `julianDate`, `sunAltitude` (astro.js); everything exported by skymap.js; `getSelectedHour` (ui.js internal); `state.prefs.{lat,lon,tz}`; `state.sky` view object and `state.skyData` catalog (added here to app.js state).
- Produces: `UI.renderSky(state)` — safe to call any time (no-ops without canvas; renders bodies/horizon even while `state.skyData` is null). Route `#/sky` ↔ section `view-sky`.

- [ ] **Step 1: index.html.** Insert the nav item directly after the Conditions `<a>` (index.html ~line 239):

```html
      <a href="#/sky" class="nav-item" data-route="sky">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>
        <span>Sky</span>
      </a>
```

Insert the section right after `</section>` of `#view-conditions`:

```html
    <section id="view-sky" class="view hidden">
      <div id="sky-caption" class="sky-caption"></div>
      <div class="sky-wrap">
        <canvas id="sky-canvas"></canvas>
        <div id="sky-status" class="sky-status">Loading star catalog…</div>
      </div>
      <p class="sky-hint">Drag to look around · pinch or scroll to zoom · time follows the scrubbed hour</p>
    </section>
```

- [ ] **Step 2: CSS.** Append at the very end of `css/style.css`:

```css
/* ==================== SKY MAP (Phase 1) ==================== */
.sky-wrap {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--line-soft);
  box-shadow: var(--card-shadow);
}
#sky-canvas {
  display: block;
  width: 100%;
  height: clamp(320px, calc(100dvh - 270px), 640px);
  touch-action: none; /* the canvas owns all gestures — page must not pan/zoom */
  cursor: grab;
}
#sky-canvas:active { cursor: grabbing; }
.sky-caption {
  font-size: 12px;
  color: var(--text-dim);
  margin: 2px 2px 8px;
}
.sky-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-dim);
  pointer-events: none;
}
.sky-hint {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  margin-top: 8px;
}
```

Then edit the night-mode filter selector at css/style.css ~1063 to include the sky canvas — change `:is(#stars, ...` to `:is(#stars, #sky-canvas, ...` (keep the rest of the list untouched).

- [ ] **Step 3: `ui.js` — `renderSky`.** Extend the astro import to include `julianDate, sunAltitude, skyBodies`, add `import { project, frameContext, starDrawList, lineDrawList, horizonDrawList, cardinalName, CARDINALS } from './skymap.js';`, then add:

```js
// --- Sky map ----------------------------------------------------------------
// Canvas colors are hardcoded hex on purpose (canvas can't read CSS vars —
// same rule as the SVG charts). Night mode reddens the whole canvas via the
// body.night filter, so no red-mode handling is needed here.
const PLANET_COLORS = { Me: '#b8a68a', V: '#efe3bd', Ma: '#e08a5a', J: '#dcc9a8', S: '#d8c07a' };
const SKY_FONT = '10px -apple-system, "Segoe UI", Roboto, sans-serif';

let skyFmtTz = null;
let skyFmt = null;

export function renderSky(state) {
  const canvas = $('sky-canvas');
  if (!canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const hour = getSelectedHour(state);
  const when = hour ? new Date(hour.time) : new Date();
  const { lat, lon } = state.prefs;
  const view = state.sky;
  const jd = julianDate(when);
  const fc = frameContext(jd, lat, lon);

  // Background keyed to the scrubbed hour's sun altitude (day/twilight/night)
  const sunAlt = hour ? hour.sunAlt : sunAltitude(when, lat, lon);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  if (sunAlt > 0) {
    grad.addColorStop(0, '#33517e');
    grad.addColorStop(1, '#4a648c');
  } else if (sunAlt > -12) {
    grad.addColorStop(0, '#0b1330');
    grad.addColorStop(1, '#2b3152');
  } else {
    grad.addColorStop(0, '#04070f');
    grad.addColorStop(1, '#0c1428');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.font = SKY_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  if (state.skyData) {
    ctx.strokeStyle = 'rgba(130,160,210,0.30)';
    ctx.lineWidth = 1;
    for (const run of lineDrawList(state.skyData.lines, fc, view, w, h)) {
      ctx.beginPath();
      run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.fillStyle = '#f2f5fa';
    for (const s of starDrawList(state.skyData.stars, fc, view, w, h)) {
      ctx.globalAlpha = Math.min(1, 0.35 + s.r * 0.28);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.name) {
        ctx.globalAlpha = 0.7;
        ctx.fillText(s.name, s.x + s.r + 3, s.y);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Horizon line + cardinal labels
  ctx.strokeStyle = 'rgba(160,190,230,0.55)';
  ctx.lineWidth = 1.5;
  for (const run of horizonDrawList(view, w, h)) {
    ctx.beginPath();
    run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(190,210,240,0.85)';
  ctx.textAlign = 'center';
  for (const [label, az] of CARDINALS) {
    const p = project(az, 0, view, w, h);
    if (p && p.x > -20 && p.x < w + 20 && p.y > -10 && p.y < h + 20) {
      ctx.fillText(label, p.x, Math.min(h - 8, p.y + 12));
    }
  }

  // Sun, moon, planets
  for (const b of skyBodies(when, lat, lon)) {
    if (b.alt < -0.5) continue;
    const p = project(b.az, b.alt, view, w, h);
    if (!p) continue;
    if (b.kind === 'sun') {
      ctx.fillStyle = 'rgba(255,217,138,0.25)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd98a';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
    } else if (b.kind === 'moon') {
      ctx.fillStyle = '#e8ecf4';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = PLANET_COLORS[b.abbr] || '#f2f5fa';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(220,230,245,0.85)';
    ctx.fillText(b.name, p.x, p.y + (b.kind === 'sun' ? 22 : 15));
  }
  ctx.textAlign = 'left';

  // Chrome: loading overlay + caption
  const status = $('sky-status');
  if (status) status.classList.toggle('hidden', !!state.skyData);
  const cap = $('sky-caption');
  if (cap) {
    if (state.prefs.tz !== skyFmtTz) {
      skyFmtTz = state.prefs.tz;
      skyFmt = new Intl.DateTimeFormat('en-US', {
        weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: skyFmtTz || undefined,
      });
    }
    cap.textContent = `${skyFmt.format(when)} · facing ${cardinalName(view.az)}`;
  }
}
```

- [ ] **Step 4: `app.js` — state, route, catalog fetch.**
  - In the state object (js/app.js:23-44) add: `sky: { az: 180, alt: 25, fov: 70 },` and `skyData: null,`.
  - In `ROUTES` (js/app.js:492) add: `'#/sky': 'sky',`.
  - In `applyRoute()`'s ready-block add: `if (route === 'sky') { ensureSkyData(); UI.renderSky(state); }` — and also call `ensureSkyData(); UI.renderSky(state);` when NOT ready (Sky renders bodies + horizon from `new Date()` even before/without forecast data), i.e. place `if (route === 'sky') { ensureSkyData(); UI.renderSky(state); }` after the ready-block, unconditional on status.
  - In `renderData()` (js/app.js:369-380) add alongside the charts/forecast lines: `if (route === 'sky') UI.renderSky(state);`.
  - In `renderSelection()` (js/app.js:359-363) add at the end: `if (route === 'sky') UI.renderSky(state);`.
  - Add near the other fetch helpers:

```js
let skyDataPromise = null;
function ensureSkyData() {
  if (state.skyData || skyDataPromise) return;
  skyDataPromise = fetch('./data/sky.json')
    .then((r) => {
      if (!r.ok) throw new Error(`sky.json ${r.status}`);
      return r.json();
    })
    .then((data) => {
      state.skyData = data;
      if (route === 'sky') UI.renderSky(state);
    })
    .catch(() => {
      skyDataPromise = null; // allow retry on next visit to the tab
    });
}
```

- [ ] **Step 5: Syntax check + tests** — `node --check js/app.js && node --check js/ui.js && npm test` — all pass (renderSky is browser-only; the check is that nothing regressed and modules still parse).

- [ ] **Step 6: Browser smoke test** — `python3 -m http.server` in repo root; open `http://localhost:8000` in a browser with the HTTP cache disabled / SW unregistered (dev-loop gotcha: stale-while-revalidate WILL serve old code otherwise — in DevTools: Application → Service Workers → Unregister, and check "Disable cache"). Verify: Sky tab appears 2nd in nav; tapping it shows the canvas with stars, constellation lines, horizon + N/E/S/W labels, labeled planets/moon (sun if daytime hour); caption shows scrubbed time; zero console errors; no horizontal scroll at 320px width. Playwright MCP may be used for this check (navigate, screenshot, read console).

- [ ] **Step 7: Commit**

```bash
git add index.html css/style.css js/ui.js js/app.js
git commit -m "feat(sky): Sky tab with canvas panorama (static render)"
```

---

### Task 6: Interactions — drag, pinch, wheel, resize

**Files:**
- Modify: `js/app.js` (add `wireSky()`, call it from `init()` next to the other `wire*()` calls; import from skymap.js)

**Interfaces:**
- Consumes: `dragView`, `zoomView` from `./skymap.js`; `state.sky`; `UI.renderSky`.
- Produces: gesture-driven updates of `state.sky` with rAF-coalesced re-renders.

- [ ] **Step 1: Implement `wireSky()`** in app.js (import `dragView, zoomView` from `./skymap.js` at the top):

```js
let skyRaf = 0;
function scheduleSkyRender() {
  if (skyRaf) return;
  skyRaf = requestAnimationFrame(() => {
    skyRaf = 0;
    UI.renderSky(state);
  });
}

function wireSky() {
  const canvas = document.getElementById('sky-canvas');
  if (!canvas) return;
  const ptrs = new Map(); // pointerId → last {x, y}
  let lastPinchDist = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    ptrs.set(e.pointerId, cur);
    if (ptrs.size === 1) {
      state.sky = dragView(state.sky, cur.x - prev.x, cur.y - prev.y, canvas.clientWidth);
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist > 0) state.sky = zoomView(state.sky, dist / lastPinchDist);
      lastPinchDist = dist;
    }
    scheduleSkyRender();
  });

  const endPtr = (e) => {
    ptrs.delete(e.pointerId);
    lastPinchDist = 0;
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.sky = zoomView(state.sky, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      scheduleSkyRender();
    },
    { passive: false }
  );

  let skyResizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(skyResizeTimer);
    skyResizeTimer = setTimeout(() => {
      if (route === 'sky') UI.renderSky(state);
    }, 150);
  });
}
```

Call `wireSky();` in `init()` alongside the existing `wireMisc()`/`wireTimeline()` calls.

- [ ] **Step 2: Syntax check** — `node --check js/app.js` — passes. `npm test` — passes.

- [ ] **Step 3: Browser verification** (same SW-bypass caveat as Task 5): drag pans smoothly and the sky follows the pointer (drag right → view rotates toward the west, caption's "facing" updates); drag down looks up; alt clamps (can't flip over zenith); scroll wheel zooms and FOV stops at 30/100 (star spacing stops changing); on the Conditions tab scrub to a different hour, return to Sky → star field has rotated and caption shows the new time; page does NOT scroll/zoom while dragging on the canvas (mobile viewport emulation); resizing the window re-renders crisply.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat(sky): drag/pinch/wheel navigation with rAF-coalesced renders"
```

---

### Task 7: Service worker, credits, docs, final verification

**Files:**
- Modify: `sw.js` (VERSION bump; SHELL additions)
- Modify: `index.html` (`#view-help` — Sky section with data credits)
- Modify: `README.md` (credits)
- Modify: `CLAUDE.md` (mark roadmap Phase 1 as built; note the sky.json regeneration command)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–6.
- Produces: an installable, offline-correct PWA including the Sky tab; license-compliant attribution (HYG is CC BY-SA 4.0 — attribution required; d3-celestial is BSD-3).

- [ ] **Step 1: sw.js** — change `const VERSION = 'starcast-v10';` → `'starcast-v11'`, and add to `SHELL`:

```js
  './js/skymap.js',
  './data/sky.json',
```

- [ ] **Step 2: Help view** — inside `#view-help` (index.html ~182), after the existing tile definitions, add a short section following the surrounding markup style (match the existing panel/dl structure in that section):

```html
      <div class="panel">
        <h2>Sky map</h2>
        <p>The Sky tab draws the stars (to magnitude 5), all 88 constellations, the Moon, Sun, and naked-eye planets for the hour you've scrubbed to. Drag to look around; pinch or scroll to zoom. Positions are computed to about a degree — great for finding things by eye, not for pointing a telescope. Star data: <a href="https://www.astronexus.com/hyg" target="_blank" rel="noopener">HYG Database</a> (CC BY-SA 4.0). Constellation lines: <a href="https://github.com/ofrohn/d3-celestial" target="_blank" rel="noopener">d3-celestial</a> (BSD-3).</p>
      </div>
```

- [ ] **Step 3: README.md** — add to the data-source credits list: `- Stars: [HYG Database](https://www.astronexus.com/hyg) (CC BY-SA 4.0) · Constellation lines: [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3-Clause) — baked into \`data/sky.json\` via \`node tools/build-sky-data.mjs\``.

- [ ] **Step 4: CLAUDE.md** — in the Roadmap section, mark Phase 1 as shipped (e.g. change the Phase 1 bullet to start with "**Phase 1 — SHIPPED (2026-08-01)**") and add one line: `data/sky.json` is generated by `node tools/build-sky-data.mjs` (checked in; regenerate only to change magnitude/name cutoffs).

- [ ] **Step 5: Full verification.**

```bash
npm test                       # all suites: astro, logic, skymap, skydata
node --check js/app.js && node --check js/ui.js && node --check js/skymap.js && node --check js/astro.js
```

Browser (SW-bypass caveat applies): full click-through of ALL tabs at 320px and desktop widths, zero console errors except the two expected 7Timer CORS errors; **night mode ON → the sky canvas renders red-tinted** (the filter list edit is what makes this pass), color-blind mode unaffected; Lighthouse/manual check that first paint of Conditions is not delayed (sky.json only loads on first Sky visit).

- [ ] **Step 6: Commit**

```bash
git add sw.js index.html README.md CLAUDE.md
git commit -m "chore(sky): SW v11 + shell entries, data credits, roadmap update"
```

- [ ] **Step 7: Finish.** Use superpowers:finishing-a-development-branch — merge `sky-map-phase1` to `main` per owner's preference (merging to `main` deploys to GitHub Pages).

---

## Self-review notes

- Spec coverage: catalog (mag ≤ 5, static JSON, HYG) → Task 3; constellation lines → Tasks 3–5; canvas 2D gnomonic projection around a view direction → Task 4; drag to look around → Task 6; stars/planets/moon/sun for the scrubbed hour → Tasks 2, 5 (renderSelection hookup); azimuth counterpart to `altitudeOf` → Task 1; works on desktop → wheel zoom + pointer events (Task 6). Owner additions: 6th tab (Task 5), pinch zoom (Task 6), labels (Tasks 3, 5).
- Type consistency: `state.sky = {az, alt, fov}` used identically in ui.js and app.js; catalog star tuple `[ra, dec, mag, name?]` consistent across generator, tests, `starDrawList`; `skyBodies` `{kind, abbr, name, ra, dec, alt, az}` consistent between Task 2 tests and Task 5 renderer.
- Known accepted trade-offs (do not "fix" during implementation): no ground-fill polygon; no atmospheric refraction; J2000 catalog positions without precession (~0.36° drift by 2026 — inside the ±1° budget); straight screen segments for long constellation edges; stars drawn even at daytime hours (it's a planning tool).
