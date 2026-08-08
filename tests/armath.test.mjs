import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orientationToView, smoothView, headingOffset, wrap180, wrap360, orientationToBasis,
  basisToView, rotateBasisZ, smoothBasis, basisAngleDeg, smoothingAlpha, adaptiveTau,
  updateRate, smoothingTau,
} from '../js/armath.js';

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

/* ================= Basis pipeline (zenith-safe AR smoothing) ================= */

test('orientationToBasis + basisToView agrees with orientationToView away from the pole', () => {
  for (const [a, b, g, s] of [[0, 90, 0, 0], [270, 90, 0, 0], [40, 135, 20, 0], [270, 60, 90, 0], [10, 100, -30, 90]]) {
    const direct = orientationToView(a, b, g, s);
    const via = basisToView(orientationToBasis(a, b, g, s));
    let dAz = Math.abs(direct.az - via.az); dAz = Math.min(dAz, 360 - dAz);
    assert.ok(dAz < 1e-6, `az ${direct.az} vs ${via.az} @${a},${b},${g},${s}`);
    assert.ok(Math.abs(direct.alt - via.alt) < 1e-6, `alt @${a},${b},${g}`);
    let dR = Math.abs(direct.roll - via.roll); dR = Math.min(dR, 360 - dR);
    assert.ok(dR < 1e-6, `roll ${direct.roll} vs ${via.roll} @${a},${b},${g}`);
  }
});

test('rotateBasisZ shifts azimuth, preserves alt and roll', () => {
  const b = orientationToBasis(0, 90, 0, 0); // facing north
  const v = basisToView(rotateBasisZ(b, 90));
  assert.ok(Math.abs(v.az - 90) < 1e-6, `az ${v.az}`); // now east
  assert.ok(Math.abs(v.alt) < 1e-6 && Math.abs(v.roll) < 1e-6, `alt ${v.alt} roll ${v.roll}`);
});

test('basisToView at the exact zenith: az from screen-up, roll 0, no NaN', () => {
  // Phone flat overhead, screen down, top of phone pointing south (beta 180)
  const v = basisToView(orientationToBasis(0, 180, 0, 0));
  assert.ok(Math.abs(v.alt - 90) < 1e-6, `alt ${v.alt}`);
  assert.ok(Math.abs(v.az - 180) < 1e-6, `az ${v.az}`); // screen-up points south
  assert.equal(v.roll, 0);
  assert.ok([v.az, v.alt, v.roll].every(Number.isFinite));
});

test('smoothBasis converges and stays orthonormal; null prev returns next', () => {
  const from = orientationToBasis(0, 90, 0, 0);
  const to = orientationToBasis(30, 120, 10, 0);
  assert.deepEqual(smoothBasis(null, to, 0.3), to);
  let b = from;
  for (let i = 0; i < 60; i++) b = smoothBasis(b, to, 0.3);
  const dot = b.f[0] * b.u[0] + b.f[1] * b.u[1] + b.f[2] * b.u[2];
  assert.ok(Math.abs(dot) < 1e-9, `f·u ${dot}`);
  assert.ok(Math.abs(Math.hypot(...b.f) - 1) < 1e-9 && Math.abs(Math.hypot(...b.u) - 1) < 1e-9);
  const want = basisToView(to); const got = basisToView(b);
  assert.ok(Math.abs(got.alt - want.alt) < 0.5, `alt ${got.alt}`);
});

test('REGRESSION: dwelling at the zenith with hand jitter renders smoothly', () => {
  // Reproduces the 2026-08-03 field report ("jumping in circles looking
  // straight up"): the old az/alt/roll smoothing averaged ~33 px/frame of
  // spurious star motion here. The basis pipeline must keep it small.
  const project = (az, alt, view, w, h) => { // minimal gnomonic, mirrors skymap.project
    const D = Math.PI / 180;
    const ca = Math.cos(alt * D);
    const x = ca * Math.sin((az - view.az) * D);
    const y0 = Math.sin(alt * D);
    const z0 = ca * Math.cos((az - view.az) * D);
    const cv = Math.cos(view.alt * D), sv = Math.sin(view.alt * D);
    const y = y0 * cv - z0 * sv, z = z0 * cv + y0 * sv;
    if (z <= 0.05) return null;
    const f = w / 2 / Math.tan((view.fov / 2) * D);
    return { x: w / 2 + (x / z) * f, y: h / 2 - (y / z) * f };
  };
  const jit = (i, p) => 3 * Math.sin(i * 2.7 + p) * Math.cos(i * 1.3 + p * 2);
  let basis = null, prev = null, maxJump = 0, total = 0, n = 0;
  for (let i = 0; i <= 200; i++) {
    const raw = orientationToBasis(jit(i, 1), 180 + jit(i, 0), jit(i, 2), 0);
    basis = smoothBasis(basis, raw, 0.25);
    const v = basisToView(basis);
    const p = project(0, 85, { az: v.az, alt: v.alt, fov: 70 }, 400, 300);
    if (p) {
      const th = -v.roll * Math.PI / 180; // ui.js draws under ctx.rotate(-roll)
      const dx = p.x - 200, dy = p.y - 150;
      const sp = { x: 200 + dx * Math.cos(th) - dy * Math.sin(th), y: 150 + dx * Math.sin(th) + dy * Math.cos(th) };
      if (prev) { const d = Math.hypot(sp.x - prev.x, sp.y - prev.y); maxJump = Math.max(maxJump, d); total += d; n++; }
      prev = sp;
    }
  }
  assert.ok(n > 150, `star visible ${n} frames`);
  assert.ok(maxJump < 15, `max frame jump ${maxJump.toFixed(1)}px (old pipeline: ~53px)`);
  assert.ok(total / n < 6, `mean motion ${(total / n).toFixed(1)}px/frame (old pipeline: ~33px)`);
});

/* ==================== Motion smoothing (AR feel) ====================
 * These lock in the 2026-08-08 fix for "AR movement is janky and moves a
 * lot". Two defects were in play: a FIXED per-event smoothing constant (so
 * behaviour depended on the device's sensor rate) and rendering only on
 * sensor events (so low-rate devices stepped visibly). The simulation below
 * mirrors the shipped pipeline: sensor events update a target at the device's
 * rate; a 60 Hz rAF loop eases the displayed basis toward it. */

/** Deterministic pseudo-noise — no Math.random, so failures reproduce. */
function noise(i, amp) {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2 * amp;
}

/** Ground-truth device attitude at time t (ms) for a steady pan. */
function truthAt(ms, panRate = 30) {
  return { alpha: (ms / 1000) * panRate, beta: 70, gamma: 0 };
}

/**
 * Run the real pipeline. `mode` is 'adaptive' (shipped: rAF easing with a
 * time-based, speed-adaptive constant) or 'fixedPerEvent' (the old code).
 */
function simulate({ sensorHz, mode, durationMs = 3000, noiseAmp = 0.35, panRate = 30 }) {
  const sensorDt = 1000 / sensorHz;
  const frameDt = 1000 / 60;
  let basis = null;
  let target = null;
  let speed = 0;
  let rateTracker = null;
  let nextSensor = 0;
  let i = 0;
  const errors = [];
  const steps = [];
  let prevView = null;

  for (let t = 0; t <= durationMs; t += frameDt) {
    while (t >= nextSensor) {
      const g = truthAt(nextSensor, panRate);
      const raw = orientationToBasis(
        g.alpha + noise(i, noiseAmp), g.beta + noise(i + 500, noiseAmp), g.gamma + noise(i + 900, noiseAmp), 0
      );
      i++;
      const next = rotateBasisZ(raw, 0);
      if (mode === 'fixedPerEvent') {
        basis = smoothBasis(basis, next, 0.25); // the old constant
      } else if (mode === 'none') {
        basis = next; // raw sensor, no filtering at all — the jitter baseline
      } else {
        rateTracker = updateRate(rateTracker, next, sensorDt);
        speed += (rateTracker.rate - speed) * smoothingAlpha(sensorDt, 150);
      }
      target = next;
      if (!basis) basis = next;
      nextSensor += sensorDt;
    }
    if (mode === 'adaptive') {
      basis = smoothBasis(basis, target, smoothingAlpha(frameDt, smoothingTau(speed, sensorDt)));
    }
    // Error against the NOISELESS truth at this instant = tracking lag.
    const ti = truthAt(t, panRate);
    const ideal = orientationToBasis(ti.alpha, ti.beta, ti.gamma, 0);
    errors.push(basisAngleDeg(basis, ideal));
    const v = basisToView(basis);
    if (prevView) steps.push(Math.abs(wrap180(v.az - prevView.az)));
    prevView = v;
  }
  const warm = Math.floor(errors.length * 0.3); // ignore the initial converge
  const settled = errors.slice(warm);
  const stepped = steps.slice(warm);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  // Jerk: how much the per-frame step size changes frame to frame. This is
  // what "janky" actually looks like — smooth motion has near-constant steps.
  const jerk = [];
  for (let k = 1; k < stepped.length; k++) jerk.push(Math.abs(stepped[k] - stepped[k - 1]));
  return { meanLag: mean(settled), maxLag: Math.max(...settled), meanJerk: mean(jerk), maxStep: Math.max(...stepped) };
}

test('smoothingAlpha is time-based and bounded', () => {
  assert.equal(smoothingAlpha(0, 100), 0, 'no elapsed time means no movement');
  assert.ok(smoothingAlpha(16, 100) < smoothingAlpha(64, 100), 'longer frames move further');
  for (const dt of [1, 16, 64, 250]) {
    const a = smoothingAlpha(dt, 100);
    assert.ok(a > 0 && a <= 1, `alpha ${a} out of range for dt ${dt}`);
  }
  assert.equal(smoothingAlpha(16, 0), 1, 'a zero time constant means snap');
  // Two half-steps must land close to one full step — the property a fixed
  // per-event k does NOT have, and the whole reason for this function.
  const one = smoothingAlpha(32, 100);
  const half = smoothingAlpha(16, 100);
  const composed = 1 - (1 - half) * (1 - half);
  assert.ok(Math.abs(one - composed) < 1e-12, `${one} vs ${composed}`);
});

test('adaptiveTau is heavy when still and light when panning fast', () => {
  assert.ok(adaptiveTau(0) > adaptiveTau(30));
  assert.ok(adaptiveTau(30) > adaptiveTau(200));
  assert.equal(adaptiveTau(0), 200);
  assert.equal(adaptiveTau(1000), 45, 'clamps at the fast end');
  // Tremor-level apparent motion must still count as holding still, or sensor
  // noise lightens the filter exactly when it should be heaviest.
  assert.equal(adaptiveTau(5), adaptiveTau(0), 'inside the deadband');
  assert.ok(adaptiveTau(12) < adaptiveTau(0), 'real motion escapes the deadband');
  for (const s of [-5, NaN, undefined, 1e9]) assert.ok(Number.isFinite(adaptiveTau(s)), `speed ${s}`);
});

test('smoothingTau never eases faster than the sensor samples', () => {
  // A 60 Hz device is unaffected; a 15 Hz one gets its floor raised so the
  // view glides between samples instead of stepping.
  assert.equal(smoothingTau(200, 1000 / 60), adaptiveTau(200), '60Hz floor never binds');
  assert.ok(smoothingTau(200, 1000 / 15) > adaptiveTau(200), '15Hz floor binds');
  assert.ok(smoothingTau(200, 1000 / 15) >= 1000 / 15, 'floor is at least one sample period');
  assert.equal(smoothingTau(0, 0), adaptiveTau(0), 'unknown sensor period falls back cleanly');
  assert.ok(smoothingTau(0, 5000) <= 200, 'a stalled sensor cannot freeze the view forever');
  for (const p of [NaN, -1, undefined]) assert.ok(Number.isFinite(smoothingTau(30, p)), `period ${p}`);
});

test('basisAngleDeg measures rotation and ignores missing input', () => {
  const a = orientationToBasis(0, 90, 0, 0);
  const b = orientationToBasis(10, 90, 0, 0);
  assert.ok(Math.abs(basisAngleDeg(a, b) - 10) < 0.01, `${basisAngleDeg(a, b)}`);
  assert.equal(basisAngleDeg(a, a), 0);
  assert.equal(basisAngleDeg(null, b), 0);
  // A pure roll must register as movement, not be reported as stillness.
  assert.ok(basisAngleDeg(orientationToBasis(0, 90, 0, 0), orientationToBasis(0, 90, 20, 0)) > 5);
});

test('AR tracking is sensor-rate independent (the jank fix)', () => {
  const fast = simulate({ sensorHz: 60, mode: 'adaptive' });
  const slow = simulate({ sensorHz: 15, mode: 'adaptive' });
  // A 15 Hz device cannot match a 60 Hz one exactly: its samples are on
  // average half a period old, which at the simulated 30 deg/s pan is
  // 0.5 * 66.7ms * 30 = 1.0 deg of irreducible sampling latency. What the fix
  // guarantees is that nothing MORE than that is lost.
  const samplingLatency = 0.5 * (1000 / 15) / 1000 * 30;
  assert.ok(Math.abs(fast.meanLag - slow.meanLag) < samplingLatency * 1.6,
    `lag gap ${(slow.meanLag - fast.meanLag).toFixed(2)}° exceeds sampling latency ${samplingLatency.toFixed(2)}°`);
  for (const r of [fast, slow]) {
    assert.ok(r.meanLag < 4.5, `tracking lag too high: ${r.meanLag.toFixed(2)}°`);
  }
  // Smoothness is the property the owner actually complained about. A 15 Hz
  // stream cannot be made EXACTLY as smooth as a 60 Hz one without predicting
  // motion between samples (deliberately not built — overshoot is worse than
  // ripple). What is required is that both stay under a perceptual budget:
  // one pixel of frame-to-frame variation at the default 70° / 400px view.
  const onePixelDeg = 70 / 400;
  for (const [name, r] of [['60Hz', fast], ['15Hz', slow]]) {
    assert.ok(r.meanJerk < onePixelDeg,
      `${name} jitter ${(r.meanJerk / onePixelDeg).toFixed(2)}px exceeds the 1px budget`);
  }
  // And the low-rate case must be clearly better than the old filter was.
  const oldSlow = simulate({ sensorHz: 15, mode: 'fixedPerEvent' });
  assert.ok(slow.meanJerk < oldSlow.meanJerk / 2,
    `15Hz smoothness barely improved: ${slow.meanJerk.toFixed(4)} vs old ${oldSlow.meanJerk.toFixed(4)}`);
  assert.ok(slow.meanLag < oldSlow.meanLag,
    `15Hz lag got worse: ${slow.meanLag.toFixed(2)}° vs old ${oldSlow.meanLag.toFixed(2)}°`);
});

test('the old fixed-per-event constant was rate-dependent and steppy', () => {
  // Documents WHY the pipeline changed; if someone reverts to a fixed k, the
  // test above starts failing and this one explains what they gave up.
  const fast = simulate({ sensorHz: 60, mode: 'fixedPerEvent' });
  const slow = simulate({ sensorHz: 15, mode: 'fixedPerEvent' });
  assert.ok(slow.meanLag > fast.meanLag * 1.8,
    `expected the old filter to lag much worse at 15Hz (${slow.meanLag.toFixed(2)}° vs ${fast.meanLag.toFixed(2)}°)`);
  const adaptiveSlow = simulate({ sensorHz: 15, mode: 'adaptive' });
  assert.ok(adaptiveSlow.meanJerk < slow.meanJerk,
    `adaptive should be smoother at 15Hz (${adaptiveSlow.meanJerk.toFixed(4)} vs ${slow.meanJerk.toFixed(4)})`);
});

test('a held-still phone does not shimmer (the "moves a lot" complaint)', () => {
  // The reported symptom was movement while trying to HOLD ON a target, so
  // this is the case that matters most. Compared against the raw sensor
  // stream, because the filter's job is to reduce jitter, not remove physics.
  const raw = simulate({ sensorHz: 60, mode: 'none', noiseAmp: 0.5, panRate: 0 });
  const filtered = simulate({ sensorHz: 60, mode: 'adaptive', noiseAmp: 0.5, panRate: 0 });
  const attenuation = raw.meanJerk / filtered.meanJerk;
  assert.ok(attenuation > 5, `only ${attenuation.toFixed(1)}x jitter attenuation while still`);
  assert.ok(filtered.maxStep < 0.25,
    `a single frame jumped ${filtered.maxStep.toFixed(3)}° while holding still`);
  // At a 70° field on a 400px canvas, 1° ≈ 5.7px — so this is sub-pixel.
  // Budget: under a quarter pixel of frame-to-frame variation at the default
  // 70° field on a 400px canvas, where 1° ≈ 5.7px.
  const degPerPx = 70 / 400;
  assert.ok(filtered.meanJerk < 0.25 * degPerPx,
    `visible shimmer: ${filtered.meanJerk.toFixed(4)}° = ${(filtered.meanJerk / degPerPx).toFixed(2)}px`);
});

test('noise attenuation holds while panning too', () => {
  const raw = simulate({ sensorHz: 60, mode: 'none', noiseAmp: 0.5 });
  const filtered = simulate({ sensorHz: 60, mode: 'adaptive', noiseAmp: 0.5 });
  assert.ok(filtered.meanJerk < raw.meanJerk / 3,
    `only ${(raw.meanJerk / filtered.meanJerk).toFixed(1)}x attenuation while panning`);
});

test('updateRate is rate-independent and window-limited', () => {
  const still = (hz) => {
    let tr = null;
    const dt = 1000 / hz;
    // A stationary phone with identical jitter on every sample.
    for (let i = 0; i < Math.round(hz * 2); i++) {
      const b = orientationToBasis(noise(i, 0.4), 70 + noise(i + 7, 0.4), 0, 0);
      tr = updateRate(tr, b, dt);
    }
    return tr.rate;
  };
  const fast = still(60);
  const slow = still(15);
  // The old per-event derivative reported ~4x more apparent motion at 60 Hz
  // than at 15 Hz for the SAME stationary phone. These must now agree.
  assert.ok(Math.abs(fast - slow) < 12, `still-phone rate: 60Hz ${fast.toFixed(1)} vs 15Hz ${slow.toFixed(1)} deg/s`);

  // A genuine pan is reported at close to its true rate.
  let tr = null;
  for (let i = 0; i < 120; i++) tr = updateRate(tr, orientationToBasis(i * 0.5, 70, 0, 0), 16.7);
  assert.ok(Math.abs(tr.rate - 30) < 5, `panning rate ${tr.rate.toFixed(1)} should be ~30 deg/s`);

  // Degenerate input must not produce NaN or explode.
  assert.equal(updateRate(null, null, 16).rate, 0);
  assert.ok(Number.isFinite(updateRate({ ref: null }, orientationToBasis(0, 70, 0, 0), -5).rate));
});
