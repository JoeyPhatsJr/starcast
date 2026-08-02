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
