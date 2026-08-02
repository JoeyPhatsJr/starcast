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
