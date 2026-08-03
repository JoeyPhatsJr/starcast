# Sky Map Phase 2 (AR mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "AR" button on the Sky tab that points the panorama with the phone's motion sensors (true-north corrected via an embedded World Magnetic Model), with an optional camera passthrough behind the stars.

**Architecture:** Two new pure modules carry all the math: `js/wmm.js` (WMM2025 spherical-harmonic declination, validated against NOAA's official test vectors) and `js/armath.js` (deviceorientation → view az/alt/roll, screen-orientation compensation, low-pass smoothing, iOS compass fusion). `app.js` owns the AR lifecycle (permissions, sensor listeners, camera stream, cleanup); `ui.js` gains a roll transform and camera-transparent rendering. Sensors cannot be verified headless — Tasks 1–4 are fully testable (unit tests + synthetic events), then Task 5 deploys to GitHub Pages for owner field-testing, with an explicit fix-cycle checklist.

**Tech Stack:** Vanilla ES modules, DeviceOrientationEvent (+ `deviceorientationabsolute`, `webkitCompassHeading`), getUserMedia, Canvas 2D, `node --test`.

## Global Constraints

- Pure static site: no build step, no npm dependencies, no CDN scripts, no API keys. `package.json` must never gain dependencies.
- All asset paths relative; site serves from `/starcast/` subpath over HTTPS (sensors require secure context — GitHub Pages provides it).
- **Bump `VERSION` in `sw.js` ('starcast-v11' → 'starcast-v12')** in the same change set as shell-file edits; add every new JS file to the SW `SHELL` array. CI guard compares `HEAD~1..HEAD` on main pushes — the final merge to main must be a merge commit or squash, never fast-forward of individual commits.
- Pure logic only in Node-testable modules (`wmm.js`, `armath.js`), never inline in `app.js`/`ui.js`. `ui.js` does all DOM writes and imports only pure modules; `app.js` owns state, event wiring, permissions, streams.
- Degrees at all API boundaries (astro.js convention). Azimuth = compass azimuth (0=N, 90=E). East-positive longitudes. `declination` is east-positive (NYC ≈ −12.5°). True azimuth = magnetic azimuth + declination.
- Night mode: no hardcoded blue/white in new CSS (vars only). The `#sky-canvas` is already red-filtered; the camera `<video>` is deliberately NOT filtered (decision recorded below). New CSS appended after the APPLE WEATHER THEME section (end of css/style.css).
- Interactive elements: `touch-action: manipulation`; the sky canvas keeps `touch-action: none`.
- iOS: `DeviceOrientationEvent.requestPermission()` MUST be called inside the user's tap handler (the AR button) — not after any `await` of anything else.
- Baseline: branch `sky-map-phase2` from up-to-date `main` (Phase 1 merged in c7902e4). Baseline tests: 47 passing.

## Locked decisions (owner-ratified 2026-08-01)

- Branch from merged main (PR #1 landed). Field-testing = deploy increments to GitHub Pages (AR is behind a button; half-done states acceptable on the beta site).
- **Camera passthrough included in this phase** (toggle, only available while AR is active).
- **Declination via WMM2025 implemented in JS** (not a precomputed grid): coefficients checked in from the public-domain NOAA `WMM.COF`, math validated against NOAA's official test values. Valid 2025.0–2030.0.
- AR entry/exit via an "AR" button overlaid on the sky canvas; camera toggle appears only in AR mode. Single-finger drag is disabled during AR (pinch/wheel FOV zoom stays active). Exiting AR keeps the last view direction.
- Night mode + camera: the video stays unfiltered (a red-filtered camera feed is useless); the canvas overlay stays filtered. Astronomers using red mode can simply not enable the camera.
- No-sensor fallback: if no orientation event arrives within 1500ms of entering AR, exit AR and show the existing toast mechanism with "No motion sensors detected".

## Validated groundwork (already proven in scratchpad prototypes — the code in Tasks 1–2 is copied from these, not speculative)

- WMM implementation matches all 6 sea-level NOAA test vectors to <0.01°: D(80°N,0°E,2025.0)=1.28, D(0°,120°E,2025.0)=−0.16, D(80°S,240°E,2025.0)=68.78, D(80°N,0°E,2027.5)=2.59, D(0°,120°E,2027.5)=−0.24, D(80°S,240°E,2027.5)=68.49. NYC 2026.6 → −12.47°.
- Orientation matrix R = Rz(α)·Rx(β)·Ry(γ) with earth frame (x=E, y=N, z=Up), view = −(third column), screen compensation R′ = R·Rz(screenAngle): passes flat/upright/east/tilt/pan cases and the rotate-device-90°+screenAngle-90° invariance property.
- Coefficient source file: NOAA `WMM.COF` (public domain), epoch 2025.0, 90 terms to degree 12. A copy exists at `/private/tmp/claude-501/-Users-joeyhabich-Claude-Starcast/6aac7e1f-e38c-449a-8a32-81f43e1eb8de/scratchpad/WMM2025COF/WMM.COF`; canonical download is https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip (zip — the checked-in copy avoids unzip in the generator).

## Integration map (verified, post-Phase-1)

- `state.sky = {az, alt, fov}` drives `UI.renderSky(state)`; gestures in `wireSky()` (js/app.js) call `dragView`/`zoomView` (js/skymap.js) and `scheduleSkyRender()` (rAF-coalesced).
- `renderSky` reads `getSelectedHour(state)`, `state.prefs.{lat,lon,tz}`, guards non-finite lat/lon, draws via skymap draw lists; `#sky-status` overlay; caption via cached `fmt(tz, opts)` helper.
- Sky section markup: `#view-sky` > `.sky-caption` + `.sky-wrap` (position:relative) > `#sky-canvas` + `#sky-status`; route `'#/sky'`; `applyRoute()` calls `ensureSkyData()` + `UI.renderSky(state)` for the sky route.
- Existing toast mechanism: app.js has an update-toast pattern; ADD a small generic `showSkyToast(msg)` in this phase (see Task 3) rather than reusing the SW update toast.
- sw.js: `VERSION = 'starcast-v11'`; SHELL includes `./js/skymap.js`, `./data/sky.json`.

---

### Task 1: WMM declination module (`js/wmm.js` + generated coefficients)

**Files:**
- Create: `tools/WMM2025.COF` (checked-in copy of NOAA's public-domain coefficient file — copy from the scratchpad path above, or re-download the zip)
- Create: `tools/build-wmm.mjs` (dev-only generator: COF → `js/wmmcof.js`)
- Create: `js/wmmcof.js` (generated, ~4KB)
- Create: `js/wmm.js`
- Test: `tests/wmm.test.mjs`

**Interfaces:**
- Produces: `js/wmmcof.js`: `export const WMM_EPOCH = 2025.0;` and `export const WMM_TERMS = [[n, m, g, h, gdot, hdot], ...];` (90 rows).
- Produces: `js/wmm.js`: `export function declination(latDeg, lonDeg, decYear)` → degrees east-positive, sea level; `export function decimalYear(date)` → e.g. 2026.58. DOM-free.

- [ ] **Step 1: Write the failing tests** — `tests/wmm.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declination, decimalYear } from '../js/wmm.js';

/* Official NOAA "Test Values for WMM2025" (sea level rows), double precision. */
const NOAA = [
  [2025.0, 80, 0, 1.28],
  [2025.0, 0, 120, -0.16],
  [2025.0, -80, 240, 68.78],
  [2027.5, 80, 0, 2.59],
  [2027.5, 0, 120, -0.24],
  [2027.5, -80, 240, 68.49],
];

test('declination matches all six NOAA WMM2025 test vectors', () => {
  for (const [yr, lat, lon, want] of NOAA) {
    const got = declination(lat, lon, yr);
    assert.ok(Math.abs(got - want) < 0.02, `D(${lat},${lon},${yr}) = ${got}, want ${want}`);
  }
});

test('NYC declination is about 12.5 degrees west', () => {
  const d = declination(40.7128, -74.006, 2026.6);
  assert.ok(d > -14 && d < -11, `NYC D ${d}`);
});

test('declination is periodic in longitude', () => {
  const a = declination(45, 10, 2026.0);
  const b = declination(45, 370, 2026.0);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
});

test('decimalYear maps mid-year sensibly', () => {
  const y = decimalYear(new Date('2026-07-02T12:00:00Z'));
  assert.ok(y > 2026.49 && y < 2026.51, `${y}`);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/wmm.test.mjs` — FAIL (module missing).

- [ ] **Step 3: Check in the COF and write the generator.** Copy the COF: `cp "/private/tmp/claude-501/-Users-joeyhabich-Claude-Starcast/6aac7e1f-e38c-449a-8a32-81f43e1eb8de/scratchpad/WMM2025COF/WMM.COF" tools/WMM2025.COF` (header line must read `2025.0            WMM-2025     11/13/2024`; if the scratchpad is gone, download https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip and extract `WMM.COF`). Then `tools/build-wmm.mjs`:

```js
// tools/build-wmm.mjs — regenerate js/wmmcof.js from tools/WMM2025.COF.
// Dev-only; run once per model release (next: WMM2030, late 2029).
// The COF file is US-government public domain (NOAA/NCEI + British Geological Survey).
import { readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync(new URL('./WMM2025.COF', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean);
const epoch = parseFloat(lines[0].split(/\s+/)[0]);
const terms = [];
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(/\s+/).map(Number);
  if (f.length < 6 || !Number.isFinite(f[0]) || f[0] > 12) continue; // skip 999... terminator
  terms.push([f[0], f[1], f[2], f[3], f[4], f[5]]);
}
if (terms.length !== 90) throw new Error(`expected 90 terms, got ${terms.length}`);

const out = `// js/wmmcof.js — GENERATED by tools/build-wmm.mjs from tools/WMM2025.COF.
// World Magnetic Model ${epoch} Gauss coefficients (NOAA/NCEI + BGS, public
// domain). Valid ${epoch}.0–${epoch + 5}.0. Do not edit by hand.
export const WMM_EPOCH = ${epoch};
export const WMM_TERMS = [
${terms.map((t) => `  [${t.join(', ')}],`).join('\n')}
];
`;
writeFileSync(new URL('../js/wmmcof.js', import.meta.url), out);
console.log(`js/wmmcof.js: epoch ${epoch}, ${terms.length} terms`);
```

Run: `node tools/build-wmm.mjs` → `js/wmmcof.js: epoch 2025, 90 terms`.

- [ ] **Step 4: Implement `js/wmm.js`** (this exact code is prototype-validated against the NOAA vectors — transcribe faithfully; the Schmidt increment `sqrt((m===1?2:1)/((n+m)*(n-m+1)))` and the minus sign in the dP formula are the two spots that break everything if altered):

```js
// js/wmm.js — magnetic declination from the World Magnetic Model (degree-12
// spherical harmonics, coefficients in ./wmmcof.js). Sea-level only: Starcast
// corrects a phone compass, and the difference over any terrestrial elevation
// is far below the compass's own noise. Validated against NOAA's official
// WMM2025 test values in tests/wmm.test.mjs.
//
// Convention: declination is EAST-POSITIVE (NYC ≈ −12.5°).
// True azimuth = magnetic azimuth + declination.
import { WMM_EPOCH, WMM_TERMS } from './wmmcof.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const N_MAX = 12;

/** Decimal year of a Date (UTC), e.g. 2026-07-02 → ≈2026.5. */
export function decimalYear(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (date.getTime() - start) / (end - start);
}

/** Magnetic declination in degrees (east-positive) at sea level. */
export function declination(latDeg, lonDeg, decYear) {
  const dt = decYear - WMM_EPOCH;
  // Geodetic (WGS84, h=0) → geocentric
  const a = 6378.137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const sinPhi = Math.sin(phi);
  const Rc = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const p = Rc * Math.cos(phi);
  const zz = Rc * (1 - e2) * sinPhi;
  const r = Math.hypot(p, zz);
  const phiP = Math.asin(zz / r); // geocentric latitude
  const s = Math.sin(phiP);
  const c = Math.cos(phiP);

  // Unnormalized associated Legendre P[n][m](sin φ′) and d/dφ′:
  //   P_mm = (2m−1)·c·P_{m−1,m−1};  P_nm = ((2n−1)·s·P_{n−1,m} − (n+m−1)·P_{n−2,m})/(n−m)
  //   dP/dφ′ = −(n·s·P_nm − (n+m)·P_{n−1,m})/c   [from the (x²−1)·P′ identity]
  const P = [];
  const dP = [];
  for (let n = 0; n <= N_MAX; n++) {
    P.push(new Array(n + 1).fill(0));
    dP.push(new Array(n + 1).fill(0));
  }
  P[0][0] = 1;
  for (let m = 1; m <= N_MAX; m++) P[m][m] = (2 * m - 1) * c * P[m - 1][m - 1];
  for (let m = 0; m < N_MAX; m++) {
    for (let n = m + 1; n <= N_MAX; n++) {
      const Pn2 = n - 2 >= m ? P[n - 2][m] : 0;
      P[n][m] = ((2 * n - 1) * s * P[n - 1][m] - (n + m - 1) * Pn2) / (n - m);
    }
  }
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const Pn1 = n - 1 >= m ? P[n - 1][m] : 0;
      dP[n][m] = -(n * s * P[n][m] - (n + m) * Pn1) / c;
    }
  }

  // Schmidt semi-normalization, built incrementally:
  // S[n][0] = 1;  S[n][m] = S[n][m−1]·sqrt((m==1?2:1)/((n+m)(n−m+1)))
  const S = [];
  for (let n = 0; n <= N_MAX; n++) {
    S.push(new Array(n + 1).fill(0));
    S[n][0] = 1;
    for (let m = 1; m <= n; m++) {
      S[n][m] = S[n][m - 1] * Math.sqrt((m === 1 ? 2 : 1) / ((n + m) * (n - m + 1)));
    }
  }

  // Time-adjusted coefficients
  const G = [];
  const H = [];
  for (let n = 0; n <= N_MAX; n++) {
    G.push(new Array(n + 1).fill(0));
    H.push(new Array(n + 1).fill(0));
  }
  for (const [n, m, g, h, gd, hd] of WMM_TERMS) {
    G[n][m] = g + dt * gd;
    H[n][m] = h + dt * hd;
  }

  // Field components in geocentric frame (X′ north, Y′ east, Z′ down)
  const aGeo = 6371.2;
  let Xp = 0;
  let Yp = 0;
  let Zp = 0;
  for (let n = 1; n <= N_MAX; n++) {
    const ar = Math.pow(aGeo / r, n + 2);
    for (let m = 0; m <= n; m++) {
      const Pb = S[n][m] * P[n][m];
      const dPb = S[n][m] * dP[n][m];
      const cm = Math.cos(m * lam);
      const sm = Math.sin(m * lam);
      const gcs = G[n][m] * cm + H[n][m] * sm;
      Xp += -ar * gcs * dPb;
      Yp += (ar * m * (G[n][m] * sm - H[n][m] * cm) * Pb) / c;
      Zp += -(n + 1) * ar * gcs * Pb;
    }
  }

  // Rotate X′/Z′ from geocentric to geodetic frame; declination from X, Y
  const psi = phiP - phi;
  const X = Xp * Math.cos(psi) - Zp * Math.sin(psi);
  return Math.atan2(Yp, X) * RAD;
}
```

- [ ] **Step 5: Run** — `node --test tests/wmm.test.mjs` → all 4 pass. Then `npm test` (51 total).

- [ ] **Step 6: Commit**

```bash
git add tools/WMM2025.COF tools/build-wmm.mjs js/wmmcof.js js/wmm.js tests/wmm.test.mjs
git commit -m "feat(wmm): WMM2025 declination model, validated against NOAA test vectors"
```

---

### Task 2: `js/armath.js` — orientation → view math

**Files:**
- Create: `js/armath.js`
- Test: `tests/armath.test.mjs`

**Interfaces:**
- Produces (all degrees; DOM-free):
  - `orientationToView(alphaDeg, betaDeg, gammaDeg, screenAngleDeg)` → `{az, alt, roll}` — az is MAGNETIC compass azimuth of the back-camera direction (caller adds declination); roll is the screen-up angle around the view axis (0 = horizon level, positive = device top tilted toward view-right).
  - `smoothView(prev, next, k)` → `{az, alt, roll}` — exponential low-pass; `prev === null` returns `next`; blends direction as a 3-vector (no az-wrap glitch) and roll by shortest arc.
  - `headingOffset(prevOffset, alphaDeg, compassHeadingDeg, k)` → number — smoothed iOS alpha-correction offset so that `alpha + offset` behaves like absolute alpha; `prevOffset === null` snaps to the instantaneous target `(360 − compassHeading − alpha) mod 360`.
  - `wrap180(deg)` → (−180, 180]; `wrap360(deg)` → [0, 360).
- Consumes: nothing from other modules (self-contained trig).

- [ ] **Step 1: Write the failing tests** — `tests/armath.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orientationToView, smoothView, headingOffset, wrap180, wrap360 } from '../js/armath.js';

const near = (a, b, tol, msg) => {
  let d = Math.abs(a - b);
  d = Math.min(d, 360 - d);
  assert.ok(d < tol, `${msg}: ${a} vs ${b}`);
};

test('flat on a table, screen up: looking straight down', () => {
  const v = orientationToView(0, 0, 0, 0);
  assert.ok(Math.abs(v.alt - -90) < 0.01, `alt ${v.alt}`);
});

test('upright portrait facing north: az 0, alt 0, roll 0', () => {
  const v = orientationToView(0, 90, 0, 0);
  near(v.az, 0, 0.01, 'az');
  assert.ok(Math.abs(v.alt) < 0.01, `alt ${v.alt}`);
  assert.ok(Math.abs(v.roll) < 0.01, `roll ${v.roll}`);
});

test('upright facing east is alpha 270', () => {
  const v = orientationToView(270, 90, 0, 0);
  near(v.az, 90, 0.01, 'az');
});

test('tilting up from upright-north raises altitude', () => {
  const v = orientationToView(0, 135, 0, 0);
  near(v.az, 0, 0.01, 'az');
  assert.ok(Math.abs(v.alt - 45) < 0.01, `alt ${v.alt}`);
});

test('screen-rotation invariance: device rotated 90° about its z + screenAngle 90 equals portrait', () => {
  // R(270, 0, 90) === R(0, 90, 0)·Rz(−90) (verified numerically at plan time)
  const base = orientationToView(0, 90, 0, 0);
  const comp = orientationToView(270, 0, 90, 90);
  near(comp.az, base.az, 0.01, 'az');
  assert.ok(Math.abs(comp.alt - base.alt) < 0.01, `alt ${comp.alt}`);
  assert.ok(Math.abs(comp.roll - base.roll) < 0.01, `roll ${comp.roll}`);
});

test('smoothView converges and crosses the 0/360 seam the short way', () => {
  let v = { az: 358, alt: 10, roll: 0 };
  for (let i = 0; i < 40; i++) v = smoothView(v, { az: 4, alt: 10, roll: 0 }, 0.3);
  near(v.az, 4, 0.5, 'az');
  assert.equal(smoothView(null, { az: 7, alt: 1, roll: 2 }, 0.3).az, 7);
});

test('headingOffset snaps first then converges with wrap', () => {
  const first = headingOffset(null, 100, 30, 0.1); // target (360-30-100)=230
  assert.equal(first, 230);
  let off = 10;
  for (let i = 0; i < 80; i++) off = headingOffset(off, 100, 30, 0.2);
  near(off, 230, 1, 'off');
});

test('wrap helpers', () => {
  assert.equal(wrap360(-10), 350);
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(180), 180);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/armath.test.mjs` — FAIL.

- [ ] **Step 3: Implement `js/armath.js`** (matrix and roll formulas are prototype-validated; transcribe faithfully):

```js
// js/armath.js — pure math for AR mode: W3C deviceorientation angles →
// where the BACK CAMERA points, as {az, alt, roll}. DOM-free, Node-tested.
//
// Frames: earth x=East, y=North, z=Up (W3C). Device angles are intrinsic
// Z-X'-Y'' (alpha about z, beta about x', gamma about y''), so
// R = Rz(α)·Rx(β)·Ry(γ) maps device coords → earth coords. The screen may be
// rotated relative to the device (landscape): compensate with R′ = R·Rz(s).
// View direction = −(device z) = −(3rd column of R′). Azimuth here is
// MAGNETIC (sensor-referenced); the caller adds WMM declination for true az.
//
// Sign conventions locked by tests; if field-testing shows a mirrored axis
// on some device, fix it HERE (one sign), never in the callers.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function wrap360(d) {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

/** Wrap to (−180, 180]. */
export function wrap180(d) {
  d = wrap360(d);
  return d > 180 ? d - 360 : d;
}

export function orientationToView(alpha, beta, gamma, screenAngle = 0) {
  const cA = Math.cos(alpha * DEG);
  const sA = Math.sin(alpha * DEG);
  const cB = Math.cos(beta * DEG);
  const sB = Math.sin(beta * DEG);
  const cG = Math.cos(gamma * DEG);
  const sG = Math.sin(gamma * DEG);
  // R = Rz(alpha)·Rx(beta)·Ry(gamma), columns are device axes in earth frame
  const R = [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG, sB, cB * cG],
  ];
  // Screen axes = device axes rotated by screenAngle about device z
  const cS = Math.cos(screenAngle * DEG);
  const sS = Math.sin(screenAngle * DEG);
  const ys = [
    -R[0][0] * sS + R[0][1] * cS,
    -R[1][0] * sS + R[1][1] * cS,
    -R[2][0] * sS + R[2][1] * cS,
  ]; // screen-up in earth frame
  const v = [-R[0][2], -R[1][2], -R[2][2]]; // back-camera direction

  const az = wrap360(Math.atan2(v[0], v[1]) * RAD);
  const alt = Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD;

  // roll: screen-up vs "up in view", around the view axis.
  // right = v × worldUp = (v.y, −v.x, 0); upInView = right × v.
  let rx = v[1];
  let ry = -v[0];
  const rl = Math.hypot(rx, ry);
  let roll = 0;
  if (rl > 1e-9) {
    rx /= rl;
    ry /= rl;
    const ux = ry * v[2];
    const uy = -rx * v[2];
    const uz = rx * v[1] - ry * v[0];
    roll = Math.atan2(ys[0] * rx + ys[1] * ry, ys[0] * ux + ys[1] * uy + ys[2] * uz) * RAD;
  }
  return { az, alt, roll };
}

/** Exponential low-pass on a view. Blends the direction as a 3-vector so the
 * az 0/360 seam never glitches; roll blends by shortest arc. k in (0, 1]. */
export function smoothView(prev, next, k) {
  if (!prev) return next;
  const toVec = (w) => {
    const ca = Math.cos(w.alt * DEG);
    return [ca * Math.sin(w.az * DEG), ca * Math.cos(w.az * DEG), Math.sin(w.alt * DEG)];
  };
  const a = toVec(prev);
  const b = toVec(next);
  const m = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const n = Math.hypot(m[0], m[1], m[2]) || 1;
  const az = wrap360(Math.atan2(m[0] / n, m[1] / n) * RAD);
  const alt = Math.asin(Math.max(-1, Math.min(1, m[2] / n))) * RAD;
  const roll = prev.roll + wrap180(next.roll - prev.roll) * k;
  return { az, alt, roll };
}

/** iOS compass fusion: webkitCompassHeading is magnetic and absolute, alpha is
 * smooth but arbitrarily referenced. Maintain offset so alpha+offset ≈ absolute
 * alpha. Snap on first sample, then converge slowly (compass is noisy). */
export function headingOffset(prevOffset, alpha, compassHeading, k) {
  const target = wrap360(360 - compassHeading - alpha);
  if (prevOffset === null || prevOffset === undefined) return target;
  return wrap360(prevOffset + wrap180(target - prevOffset) * k);
}
```

- [ ] **Step 4: Run** — `node --test tests/armath.test.mjs` then `npm test` — all pass (59 total expected).

- [ ] **Step 5: Commit**

```bash
git add js/armath.js tests/armath.test.mjs
git commit -m "feat(armath): deviceorientation to az/alt/roll with smoothing and iOS compass fusion"
```

---

### Task 3: AR mode — button, sensors, lifecycle, roll rendering

**Files:**
- Modify: `index.html` (AR button inside `.sky-wrap`)
- Modify: `css/style.css` (append `.sky-tools` styles at EOF; no blue/white — vars only)
- Modify: `js/app.js` (state.ar, enterAR/exitAR, sensor handler, toast, drag-disable, route/visibility cleanup)
- Modify: `js/ui.js` (roll transform in renderSky, AR button state, caption "AR" prefix)

**Interfaces:**
- Consumes: `orientationToView`, `smoothView`, `headingOffset`, `wrap360` (armath.js); `declination`, `decimalYear` (wmm.js); existing `state.sky`, `scheduleSkyRender`, `zoomView`.
- Produces: `state.ar = { active: false, camera: false, decl: 0, offset: null, view: null, lastEventAt: 0 }`; `state.sky.roll` (number|undefined — renderSky rotates the scene when set and AR active); `showSkyToast(msg)` in app.js; `UI.renderSky` handles `state.ar.active` (button pressed state, caption prefix, roll).

- [ ] **Step 1: Markup.** In `index.html`, inside `.sky-wrap` (after `#sky-status`):

```html
        <div class="sky-tools">
          <button id="sky-ar-btn" class="sky-tool-btn" type="button" aria-pressed="false">AR</button>
          <button id="sky-cam-btn" class="sky-tool-btn hidden" type="button" aria-pressed="false" aria-label="Camera passthrough">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
        </div>
        <div id="sky-toast" class="sky-toast hidden"></div>
```

- [ ] **Step 2: CSS** (append at very end of css/style.css):

```css
/* ==================== SKY AR (Phase 2) ==================== */
.sky-tools {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 8px;
  z-index: 3;
}
.sky-tool-btn {
  min-width: 44px;
  height: 36px;
  padding: 0 12px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text-dim);
  font: 600 13px -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: manipulation;
  cursor: pointer;
}
.sky-tool-btn[aria-pressed="true"] {
  color: var(--text);
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.sky-toast {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 3;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: var(--radius);
  padding: 8px 14px;
  font-size: 13px;
  max-width: 90%;
  text-align: center;
  pointer-events: none;
}
```

- [ ] **Step 3: app.js wiring.** Add imports: `import { orientationToView, smoothView, headingOffset } from './armath.js';` and `import { declination, decimalYear } from './wmm.js';`. Add to the state object: `ar: { active: false, camera: false, decl: 0, offset: null, view: null, lastEventAt: 0 },`. Then:

```js
// --- AR mode ---------------------------------------------------------------
let skyToastTimer = 0;
function showSkyToast(msg) {
  const el = document.getElementById('sky-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(skyToastTimer);
  skyToastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function screenAngle() {
  return (screen.orientation && Number.isFinite(screen.orientation.angle))
    ? screen.orientation.angle
    : (Number(window.orientation) || 0);
}

let arHasAbsolute = false;
let arSensorTimer = 0;

function onOrientation(e) {
  if (!state.ar.active || e.alpha === null || e.alpha === undefined) return;
  // Prefer absolute events; once one arrives, ignore the relative stream.
  const isAbsolute = e.type === 'deviceorientationabsolute' || e.absolute === true;
  if (isAbsolute) arHasAbsolute = true;
  else if (arHasAbsolute) return;

  let alpha = e.alpha;
  if (!isAbsolute && typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    // iOS: fuse the absolute (noisy) compass with the smooth (relative) gyro alpha
    state.ar.offset = headingOffset(state.ar.offset, e.alpha, e.webkitCompassHeading, 0.05);
    alpha = e.alpha + state.ar.offset;
  }
  state.ar.lastEventAt = Date.now();

  const raw = orientationToView(alpha, e.beta, e.gamma, screenAngle());
  raw.az = (raw.az + state.ar.decl + 360) % 360; // magnetic → true north
  state.ar.view = smoothView(state.ar.view, raw, 0.25);
  state.sky = {
    az: state.ar.view.az,
    alt: Math.max(-30, Math.min(89, state.ar.view.alt)),
    fov: state.sky.fov,
    roll: state.ar.view.roll,
  };
  scheduleSkyRender();
}

function enterAR() {
  const finish = () => {
    state.ar.active = true;
    state.ar.offset = null;
    state.ar.view = null;
    state.ar.lastEventAt = 0;
    arHasAbsolute = false;
    state.ar.decl = declination(state.prefs.lat, state.prefs.lon, decimalYear(new Date()));
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    clearTimeout(arSensorTimer);
    arSensorTimer = setTimeout(() => {
      if (state.ar.active && !state.ar.lastEventAt) {
        exitAR();
        showSkyToast('No motion sensors detected');
      }
    }, 1500);
    UI.renderSky(state);
  };
  // iOS 13+: must be called synchronously inside the tap gesture
  if (typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then((res) => {
        if (res === 'granted') finish();
        else showSkyToast('Motion access denied — enable it in Settings › Safari');
      })
      .catch(() => showSkyToast('Motion access unavailable'));
  } else {
    finish();
  }
}

function exitAR() {
  clearTimeout(arSensorTimer);
  window.removeEventListener('deviceorientationabsolute', onOrientation, true);
  window.removeEventListener('deviceorientation', onOrientation, true);
  stopCamera(); // no-op until Task 4 wires the camera
  state.ar.active = false;
  delete state.sky.roll;
  UI.renderSky(state);
}

function wireAR() {
  const btn = document.getElementById('sky-ar-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.ar.active) exitAR();
    else if (!Number.isFinite(state.prefs.lat)) showSkyToast('Waiting for location…');
    else enterAR();
  });
  // Leaving the tab or backgrounding the app ends AR (sensors + battery)
  window.addEventListener('hashchange', () => { if (state.ar.active && route !== 'sky') exitAR(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.ar.active) exitAR();
  });
}
```

Placeholder for Task 4 (add now so exitAR compiles): `function stopCamera() {}` with a `// replaced in camera task` comment. Call `wireAR();` in `init()` next to `wireSky();`. In `wireSky()`'s `pointermove` single-pointer branch, add the AR guard: `if (ptrs.size === 1) { if (state.ar.active) return; state.sky = dragView(...); }` — pinch (2-pointer) and wheel zoom stay live in AR.

**Note on the hashchange listener:** `applyRoute` runs on hashchange too; the added listener only handles the AR teardown and must not duplicate render calls (exitAR's render is cheap and idempotent).

- [ ] **Step 4: ui.js.** In `renderSky`, three additions (keep them minimal):
  1. After computing `w`/`h` and before drawing, wrap the whole scene draw in a roll transform when AR is on:

```js
  const roll = state.ar && state.ar.active && Number.isFinite(state.sky.roll) ? state.sky.roll : 0;
  ctx.save();
  if (roll) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(roll * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  // ...(existing background/lines/stars/horizon/bodies drawing, unchanged)...
  ctx.restore();
```

  (The background gradient fill goes INSIDE the rotation — overscan it by painting `ctx.fillRect(-w, -h, 3 * w, 3 * h)` instead of `(0, 0, w, h)` so corners stay covered while rotated. FIELD-TEST CHECKPOINT: if the horizon tilts the wrong way on a real phone, flip to `ctx.rotate(-roll * …)` — one sign, here only.)
  2. Button states at the end of renderSky:

```js
  const arBtn = $('sky-ar-btn');
  if (arBtn) arBtn.setAttribute('aria-pressed', state.ar && state.ar.active ? 'true' : 'false');
  const camBtn = $('sky-cam-btn');
  if (camBtn) {
    camBtn.classList.toggle('hidden', !(state.ar && state.ar.active));
    camBtn.setAttribute('aria-pressed', state.ar && state.ar.camera ? 'true' : 'false');
  }
```

  3. Caption prefix: where the caption is set, prepend `AR · ` when `state.ar.active`.

- [ ] **Step 5: Verify.** `node --check js/app.js && node --check js/ui.js && npm test` (59 pass). Browser (python3 -m http.server 8901 + Playwright MCP; unregister SW + clear caches first, reload):
  - `#/sky` shows the AR pill top-right; clicking it (no sensors in a desktop browser, `requestPermission` absent → `finish()` runs) enters AR, then after 1.5s auto-exits with the "No motion sensors detected" toast. Confirm button pressed-state toggles and no console errors.
  - Synthetic sensor check via `browser_evaluate`: enter AR, then within 1.5s dispatch `window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0 }))`. (Constructor-made events have `absolute: false` and no `webkitCompassHeading`, so alpha is used raw — that's fine for plumbing verification.) Caption should flip to "AR · facing …" with az declination-corrected: for the NYC default location, alpha 0 → az ≈ 347.5, which the caption rounds to "N". Dispatch a second event with `alpha: 270` → facing ≈ E (77.5 → "E"). Screenshot each; confirm canvas changed and no errors. Also confirm single-finger drag does nothing while AR is on, and wheel zoom still works.
  - Exit AR via the button → drag works again.

- [ ] **Step 6: Commit**

```bash
git add index.html css/style.css js/app.js js/ui.js
git commit -m "feat(ar): sensor-driven AR mode with declination correction and roll"
```

---

### Task 4: Camera passthrough

**Files:**
- Modify: `index.html` (video element in `.sky-wrap`, before the canvas)
- Modify: `css/style.css` (video layer + camera-on canvas transparency, appended)
- Modify: `js/app.js` (replace the `stopCamera` stub; `startCamera`, camera button wiring, cleanup in exitAR already calls stopCamera)
- Modify: `js/ui.js` (renderSky: translucent scrim instead of opaque gradient when camera on)

**Interfaces:**
- Consumes: `state.ar.{active, camera}` from Task 3; `showSkyToast`.
- Produces: `#sky-camera` video element; `state.ar.camera` true while streaming.

- [ ] **Step 1: Markup.** First child of `.sky-wrap`:

```html
        <video id="sky-camera" class="hidden" autoplay muted playsinline></video>
```

- [ ] **Step 2: CSS** (append):

```css
#sky-camera {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
}
.sky-wrap canvas { position: relative; z-index: 1; }
/* Night mode deliberately does NOT filter the camera feed — a red-filtered
   camera is useless. The star overlay above it stays filtered. */
```

- [ ] **Step 3: app.js.** Replace the stub:

```js
let camStream = null;
function stopCamera() {
  if (camStream) {
    for (const t of camStream.getTracks()) t.stop();
    camStream = null;
  }
  const video = document.getElementById('sky-camera');
  if (video) {
    video.srcObject = null;
    video.classList.add('hidden');
  }
  state.ar.camera = false;
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showSkyToast('Camera not available');
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    const video = document.getElementById('sky-camera');
    video.srcObject = camStream;
    video.classList.remove('hidden');
    state.ar.camera = true;
  } catch {
    showSkyToast('Camera unavailable or permission denied');
    state.ar.camera = false;
  }
  UI.renderSky(state);
}
```

In `wireAR()`, wire the camera button: `document.getElementById('sky-cam-btn')?.addEventListener('click', () => { if (state.ar.camera) { stopCamera(); UI.renderSky(state); } else startCamera(); });`

- [ ] **Step 4: ui.js.** In `renderSky`'s background section: when `state.ar && state.ar.camera`, replace the opaque gradient fill with a scrim so stars overlay the feed: `ctx.clearRect(-w, -h, 3 * w, 3 * h); ctx.fillStyle = 'rgba(2, 4, 10, 0.35)'; ctx.fillRect(-w, -h, 3 * w, 3 * h);` (canvas hex/rgba allowed — charts precedent).

- [ ] **Step 5: Verify.** `node --check js/app.js && node --check js/ui.js && npm test`. Browser (headless has no camera): enter AR (desktop path), click the camera button → the denial path must show the toast and leave everything working, `state.ar.camera` false, no unhandled rejection in console. Confirm exiting AR while "camera on" state runs stopCamera without errors (test by stubbing: `browser_evaluate` → `navigator.mediaDevices.getUserMedia = () => Promise.resolve(new MediaStream())` then toggling camera, then exiting AR — no errors, video hidden again).

- [ ] **Step 6: Commit**

```bash
git add index.html css/style.css js/app.js js/ui.js
git commit -m "feat(ar): camera passthrough toggle with stream lifecycle cleanup"
```

---

### Task 5: SW bump, docs, deploy for field-testing

**Files:**
- Modify: `sw.js` (VERSION 'starcast-v11' → 'starcast-v12'; SHELL += `'./js/wmm.js', './js/wmmcof.js', './js/armath.js'`)
- Modify: `index.html` (Help: one paragraph on AR in the existing Sky map panel)
- Modify: `README.md` (feature line + WMM note)
- Modify: `CLAUDE.md` (roadmap: Phase 2 core shipped, field-test tuning in progress; note `tools/build-wmm.mjs` regeneration for WMM2030)

- [ ] **Step 1: sw.js** — bump VERSION to `'starcast-v12'`; add the three new JS files to SHELL with `'./'` prefix (after `'./js/skymap.js'`). `tools/` files and the COF are NOT in the shell.

- [ ] **Step 2: Help.** Inside the existing "Sky map" panel in `#view-help`, append to the paragraph (keep `class="help-p"` structure): a sentence like: `On a phone, the AR button points the map with your device's motion sensors — headings are corrected from magnetic to true north using the World Magnetic Model (WMM2025, NOAA/NCEI & BGS, public domain), and the camera button shows the live sky behind the stars.`

- [ ] **Step 3: README.md** — under features (match list style): `- **AR mode** — on phones, the Sky tab can track your device's motion sensors (compass corrected to true north via an embedded WMM2025 model) with optional camera passthrough.` Data-sources list gains: `- **[World Magnetic Model 2025](https://www.ncei.noaa.gov/products/world-magnetic-model)** — declination coefficients (NOAA/NCEI & BGS, public domain); baked into \`js/wmmcof.js\` via \`node tools/build-wmm.mjs\`.`

- [ ] **Step 4: CLAUDE.md** — roadmap: mark Phase 2 core as shipped 2026-08-01 with "sensor-tuning field-test cycle in progress"; add one line: WMM coefficients regenerate via `node tools/build-wmm.mjs` when WMM2030 releases (late 2029).

- [ ] **Step 5: Full verification.** `npm test` (59); `node --check` on js/app.js js/ui.js js/wmm.js js/wmmcof.js js/armath.js; browser click-through of all tabs (console clean except the 2 expected 7Timer CORS errors), night mode on `#/sky` still fully red (AR pill uses vars, so it reddens automatically), 320px viewport intact, AR desktop fallback toast still works.

- [ ] **Step 6: Commit**

```bash
git add sw.js index.html README.md CLAUDE.md
git commit -m "chore(ar): SW v12 + shell entries, WMM credits, roadmap update"
```

- [ ] **Step 7: Land and deploy.** After final review: push branch, PR to main (merge-commit or squash — never fast-forward), merge → Pages deploys. Then hand the owner the field-test checklist below.

## Field-test checklist (owner, on phone, after deploy — expect a fix cycle)

Load the live site, hard-refresh twice (SW update), open Sky → AR:

1. **iOS permission prompt** appears on first AR tap and AR starts after Allow.
2. **Compass sanity:** face a known direction (sun's azimuth around this hour, or a street you know) — the caption's "facing" should match within ~5–10°. If it's off by ~12–13° consistently, declination sign is flipped (fix: `raw.az − state.ar.decl` in onOrientation). If off by 90/180, report the numbers.
3. **Tilt:** raising the phone raises altitude; straight up ≈ +90.
4. **Roll:** tilt the phone sideways — the horizon line should stay level with the real horizon. If it tilts the wrong way: flip the one `ctx.rotate` sign in renderSky.
5. **Rotate to landscape** — view should stay pointed at the same sky patch.
6. **Jitter/lag:** star field should be steady, ~quarter-second lag max. Report "too laggy" or "too jittery" — tune `smoothView` k (0.25) and iOS `headingOffset` k (0.05).
7. **Camera:** toggle on → live feed behind stars; stars roughly align with real bright stars/planets; toggle off; exit AR; leave the tab — camera LED/indicator must go off every time.
8. **Android (if available):** same checks; watch for "facing" drifting over a minute (means absolute events aren't firing — report).

## Deliberately out of scope (Phase 2)

- Star-tap identification, object search/goto arrows (Phase 3 candidates).
- Altitude input to WMM (sea level only — compass noise dwarfs the difference).
- Sensor-fusion beyond low-pass (no Kalman; tune constants first).
- Persisting AR/camera state across sessions.

## Self-review notes

- Spec coverage vs roadmap: AR button ✓ (Task 3), requestPermission-in-gesture ✓ (enterAR), deviceorientationabsolute ✓ (listener + preference logic), rotation-matrix conversion ✓ (armath), screen-orientation compensation ✓ (screenAngle + R·Rz(s)), low-pass filtering ✓ (smoothView), magnetic declination ✓ (WMM in JS — owner-ratified upgrade over the table), camera passthrough ✓ (Task 4), build→field-test→fix cycle ✓ (Task 5 checklist).
- Type consistency: `state.ar` shape identical across Tasks 3–4; `orientationToView` degrees-in/degrees-out consistent with tests; `state.sky.roll` read guarded by `Number.isFinite`.
- Known accepted trade-offs (do not "fix"): sea-level declination; single-stage low-pass; iOS compass fusion constant chosen by feel; camera feed unfiltered in night mode; desktop AR button visible but exits via no-sensor toast.
