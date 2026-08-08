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

test('declination is finite at the exact poles', () => {
  assert.ok(Number.isFinite(declination(90, 0, 2026.5)));
  assert.ok(Number.isFinite(declination(-90, 45, 2026.5)));
});
