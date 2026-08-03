import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orientationToView, smoothView, headingOffset, wrap180, wrap360, orientationToBasis, basisToView, rotateBasisZ, smoothBasis } from '../js/armath.js';

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
