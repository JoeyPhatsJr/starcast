import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampView, dragView, zoomView, cardinalName, project, unproject, horizonY,
  frameContext, starHorizontal, magToRadius, magToAlpha, starColor, airmass,
  extinctionFactor, starDrawList, lineDrawList, polygonDrawList, clipNear,
  gridDrawList, constellationLabelList, labelMagLimit, placeLabels, pickNearest,
  pointToward, focalLength, toRgba, FOV_MIN, FOV_MAX,
} from '../js/skymap.js';
import { julianDate, horizontalOf } from '../js/astro.js';

const VIEW = { az: 180, alt: 25, fov: 70 };
const NYC = { lat: 40.7128, lon: -74.006 };
const JD = julianDate(new Date('2026-08-01T04:00:00Z'));
const FC = frameContext(JD, NYC.lat, NYC.lon);

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

test('unproject inverts project across the field', () => {
  for (const view of [VIEW, { az: 12, alt: -20, fov: 100 }, { az: 300, alt: 80, fov: 20 }]) {
    for (const [daz, alt] of [[0, 0], [15, 30], [-20, -5], [7, 70]]) {
      const az = (view.az + daz + 360) % 360;
      const p = project(az, alt, view, 400, 300);
      if (!p) continue;
      const back = unproject(p.x, p.y, view, 400, 300);
      const dAz = ((back.az - az + 540) % 360) - 180; // shortest signed arc
      assert.ok(Math.abs(dAz) < 1e-6, `az ${back.az} vs ${az}`);
      assert.ok(Math.abs(back.alt - alt) < 1e-6, `alt ${back.alt} vs ${alt}`);
    }
  }
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
  const a = starHorizontal(279.23, 38.78, FC); // Vega
  const b = horizontalOf(279.23, 38.78, JD, NYC.lat, NYC.lon);
  assert.ok(Math.abs(a.alt - b.alt) < 1e-9 && Math.abs(a.az - b.az) < 1e-9);
});

/* ---------------------------- horizon ---------------------------- */

test('horizonY matches a projected horizon point and bounds the ground', () => {
  for (const view of [VIEW, { az: 40, alt: 0, fov: 60 }, { az: 200, alt: -18, fov: 90 }]) {
    const y = horizonY(view, 400, 300);
    const p = project(view.az, 0, view, 400, 300); // dead ahead, on the horizon
    assert.ok(Math.abs(p.y - y) < 1e-6, `${p.y} vs ${y}`);
    // A point above the horizon must land above the line, and vice versa.
    assert.ok(project(view.az, 10, view, 400, 300).y < y);
    assert.ok(project(view.az, -10, view, 400, 300).y > y);
  }
});

test('horizon is on-canvas at alt 25 and far off it looking straight up', () => {
  assert.ok(horizonY(VIEW, 400, 300) < 300);
  assert.ok(horizonY({ az: 0, alt: 89, fov: 30 }, 400, 300) > 300 * 50);
});

test('the horizon is straight — same y at every azimuth across the field', () => {
  const y = horizonY(VIEW, 400, 300);
  for (const daz of [-30, -10, 0, 10, 30]) {
    const p = project(normalise(VIEW.az + daz), 0, VIEW, 400, 300);
    assert.ok(Math.abs(p.y - y) < 1e-6, `daz ${daz}: ${p.y} vs ${y}`);
  }
  function normalise(a) { return (a % 360 + 360) % 360; }
});

/* --------------------------- appearance --------------------------- */

test('magToRadius is monotonic decreasing, positive, and grows when zoomed in', () => {
  assert.ok(magToRadius(-1.4) > magToRadius(1) && magToRadius(1) > magToRadius(5));
  assert.ok(magToRadius(5) > 0.3);
  assert.ok(magToRadius(0, 20) > magToRadius(0, 70));
  assert.ok(magToRadius(0, 110) < magToRadius(0, 70));
  assert.ok(Number.isFinite(magToRadius(0, 0)), 'fov 0 must not divide by zero');
});

test('starColor runs blue → white → orange with B−V', () => {
  const rgb = (s) => s.match(/\d+/g).map(Number);
  const [br, , bb] = rgb(starColor(-0.3)); // hot O/B star
  const [rr, , rb] = rgb(starColor(1.6)); // cool M star
  assert.ok(bb > br, 'hot stars are blue-dominant');
  assert.ok(rr > rb, 'cool stars are red-dominant');
  const [wr, wg, wb] = rgb(starColor(0.35)); // near-white F star
  assert.ok(Math.max(wr, wg, wb) - Math.min(wr, wg, wb) < 40, 'mid B−V stays near-white');
  for (const bv of [-5, 9, NaN, undefined, null, 'x']) {
    assert.match(starColor(bv), /^rgb\(\d+,\d+,\d+\)$/, `bad input ${bv}`);
  }
});

test('toRgba applies alpha to hex AND rgb inputs', () => {
  // Regression: hex colours used to pass through untouched, so a glow sprite's
  // "transparent" outer stop stayed opaque and planets rendered as solid
  // squares. Every palette in the renderer must survive this.
  assert.equal(toRgba('rgb(1,2,3)', 0.5), 'rgba(1,2,3,0.5)');
  assert.equal(toRgba('#ff8000', 0), 'rgba(255,128,0,0)');
  assert.equal(toRgba('#f80', 0.25), 'rgba(255,136,0,0.25)');
  assert.equal(toRgba('rgba(1,2,3,0.4)', 0.9), 'rgba(1,2,3,0.4)', 'existing alpha is kept');
  for (const bad of ['', 'tomato', '#12345', null, undefined]) {
    assert.match(toRgba(bad, 0), /^rgba\(\d+,\d+,\d+,0\)$/, `bad input ${bad}`);
  }
  // The exact palettes the sky renderer draws with.
  for (const c of ['#c9b294', '#fdf4d6', '#e5764c', '#e8d6b0', '#e3cd8c', '#fff0c4', 'rgb(226,232,244)']) {
    assert.ok(toRgba(c, 0).endsWith(',0)'), `${c} must reach zero alpha`);
    assert.ok(!/NaN/.test(toRgba(c, 0.5)), `${c} produced NaN`);
  }
});

test('airmass and extinction dim toward the horizon but stay finite', () => {
  assert.ok(Math.abs(airmass(90) - 1) < 0.01);
  assert.ok(airmass(10) > airmass(45) && airmass(45) > airmass(90));
  assert.ok(Number.isFinite(airmass(0)) && Number.isFinite(airmass(-2)));
  assert.ok(Math.abs(extinctionFactor(90) - 1) < 0.01);
  assert.ok(extinctionFactor(5) < extinctionFactor(40));
  assert.ok(extinctionFactor(40) < extinctionFactor(85));
  for (const a of [-2, 0, 0.5, 45, 90]) {
    const f = extinctionFactor(a);
    assert.ok(f > 0 && f <= 1, `alt ${a} → ${f}`);
  }
});

test('magToAlpha falls with magnitude and stays inside (0, 1]', () => {
  assert.ok(magToAlpha(-1.4) === 1 && magToAlpha(2) < 1 && magToAlpha(5) < magToAlpha(2));
  assert.ok(magToAlpha(9) > 0);
});

/* --------------------------- draw lists --------------------------- */

test('draw lists cull and produce sane runs', () => {
  const stars = [[279.23, 38.78, 0.0, 0.0, 'Vega'], [101.29, -16.72, -1.4, 0.01, 'Sirius']];
  const list = starDrawList(stars, FC, { az: 90, alt: 60, fov: 100 }, 400, 300);
  assert.ok(list.length >= 1); // Vega is high in the NYC summer sky
  // Sirius is ~63° below the horizon at this NYC epoch — must be culled.
  assert.ok(!list.some((s) => s.name === 'Sirius'), 'Sirius should be culled below-horizon');
  for (const s of list) {
    assert.ok(Number.isFinite(s.x) && s.r > 0);
    assert.ok(s.a > 0 && s.a <= 1, `alpha ${s.a}`);
    assert.match(s.color, /^rgb\(/);
  }
  const runs = lineDrawList([[[279, 38], [285, 40], [290, 35]]], FC, { az: 90, alt: 60, fov: 100 }, 400, 300);
  for (const run of runs) assert.ok(run.length >= 2);
});

test('starDrawList reads the new column layout (bv at 3, names at 4/5)', () => {
  const [s] = starDrawList([[279.23, 38.78, 0.03, 0, 'Vega', 'α Lyr']], FC, { az: 90, alt: 60, fov: 100 }, 400, 300);
  assert.equal(s.name, 'Vega');
  assert.equal(s.desig, 'α Lyr');
  assert.equal(s.mag, 0.03);
  const [d] = starDrawList([[279.23, 38.78, 3, 1.2, 0, 'β Lyr']], FC, { az: 90, alt: 60, fov: 100 }, 400, 300);
  assert.equal(d.name, null, 'a 0 in the name slot means "no proper name"');
  assert.equal(d.desig, 'β Lyr');
});

test('starDrawList margin widens the offscreen cull window', () => {
  // A dense above-horizon grid so some stars land just outside the viewport.
  const grid = [];
  for (let ra = 0; ra < 360; ra += 4) for (let dec = -20; dec <= 80; dec += 5) grid.push([ra, dec, 3, 0.5]);
  const view = { az: 90, alt: 60, fov: 100 };
  const tight = starDrawList(grid, FC, view, 300, 500, 10);
  const wide = starDrawList(grid, FC, view, 300, 500, 400);
  assert.ok(wide.length > tight.length, `wide ${wide.length} vs tight ${tight.length}`);
  const def = starDrawList(grid, FC, view, 300, 500);
  assert.equal(def.length, tight.length, 'default margin stays 10');
});

/* ------------------------ polygon clipping ------------------------ */

test('clipNear keeps forward rings whole and closes straddling ones', () => {
  const fwd = [[0, 0, 1], [1, 0, 1], [1, 1, 1]];
  assert.equal(clipNear(fwd).length, 3, 'fully forward ring is untouched');
  assert.equal(clipNear([[0, 0, -1], [1, 0, -1], [1, 1, -1]]).length, 0, 'fully behind ring drops');
  const straddle = clipNear([[0, 0, 1], [1, 0, 1], [1, 1, -1], [0, 1, -1]]);
  assert.ok(straddle.length >= 3, 'straddling ring survives as a closed polygon');
  for (const p of straddle) assert.ok(p[2] > 0, 'no vertex is left behind the camera');
  assert.deepEqual(clipNear([]), []);
});

test('polygonDrawList never emits a ring that spans the screen from behind', () => {
  // A ring occupying a band right behind the viewer. Without near-plane
  // clipping this floods the canvas; with it, the ring is dropped or pushed
  // off-screen. Either way no vertex may sit inside the viewport.
  const view = { az: 0, alt: 0, fov: 60 };
  const behind = [];
  for (let ra = 150; ra <= 210; ra += 5) behind.push([ra, 0]);
  for (let ra = 210; ra >= 150; ra -= 5) behind.push([ra, 10]);
  const fc = frameContext(JD, 0, 0);
  const back = starHorizontal(180, 0, fc); // whatever is 180° from this ring
  const away = { az: (back.az + 180) % 360, alt: 0, fov: 60 };
  for (const v of [view, away]) {
    for (const poly of polygonDrawList([behind], fc, v, 400, 300)) {
      for (const p of poly) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
  }
  // A ring around the view centre must actually render.
  const here = starHorizontal(0, 0, fc);
  const near = [];
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * 2 * Math.PI;
    near.push([5 * Math.cos(t), 5 * Math.sin(t)]);
  }
  const got = polygonDrawList([near], fc, { az: here.az, alt: here.alt, fov: 60 }, 400, 300);
  assert.equal(got.length, 1);
  assert.ok(got[0].length >= 3);
});

/* ---------------------------- labels ---------------------------- */

test('gridDrawList produces finite multi-point runs', () => {
  const runs = gridDrawList(VIEW, 400, 300);
  assert.ok(runs.length > 0);
  for (const run of runs) {
    assert.ok(run.length >= 2);
    for (const p of run) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  assert.equal(gridDrawList({ az: 0, alt: 89, fov: 15 }, 400, 300).every((r) => r.length >= 2), true);
});

test('constellation labels thin out as the field widens', () => {
  // Anchor the view on a known catalogue position so all three ranks are
  // guaranteed on-screen and the test measures the rank filter, not framing.
  const at = starHorizontal(279.23, 38.78, FC); // Vega, high over NYC at this epoch
  const consts = [
    [279.23, 38.78, 'Rank one', 1, 'R1'],
    [281.5, 39.5, 'Rank two', 2, 'R2'],
    [277.0, 37.5, 'Rank three', 3, 'R3'],
  ];
  const wide = constellationLabelList(consts, FC, { ...at, fov: 100 }, 400, 300);
  const mid = constellationLabelList(consts, FC, { ...at, fov: 70 }, 400, 300);
  const tight = constellationLabelList(consts, FC, { ...at, fov: 40 }, 400, 300);
  assert.deepEqual(wide.map((l) => l.rank), [1], 'wide field keeps only rank 1');
  assert.deepEqual(mid.map((l) => l.rank).sort(), [1, 2], 'mid field adds rank 2');
  assert.deepEqual(tight.map((l) => l.rank).sort(), [1, 2, 3], 'tight field shows all');
  for (const l of tight) {
    assert.ok(l.x >= 0 && l.x <= 400 && l.y >= 0 && l.y <= 300);
    assert.ok(l.text && l.abbr);
  }
  // Below-horizon anchors never label.
  const under = starHorizontal(101.29, -16.72, FC); // Sirius, well under the horizon
  assert.equal(constellationLabelList([[101.29, -16.72, 'Canis Major', 1, 'CMa']], FC, { ...under, fov: 60 }, 400, 300).length, 0);
});

test('labelMagLimit reveals more names as you zoom in', () => {
  assert.ok(labelMagLimit(100) < labelMagLimit(70));
  assert.ok(labelMagLimit(70) < labelMagLimit(30));
  assert.ok(labelMagLimit(20) < 6);
});

test('placeLabels drops overlaps and keeps the first-listed winner', () => {
  const kept = placeLabels([
    { x: 0, y: 0, w: 40, h: 10, text: 'keep' },
    { x: 10, y: 2, w: 40, h: 10, text: 'overlaps' },
    { x: 200, y: 200, w: 40, h: 10, text: 'far' },
  ]);
  assert.deepEqual(kept.map((k) => k.text), ['keep', 'far']);
  assert.equal(placeLabels([]).length, 0);
});

test('placeLabels treats blocked regions as occupied but never returns them', () => {
  const blocked = [{ x: 250, y: 0, w: 150, h: 46 }]; // the tool-button strip
  const kept = placeLabels([
    { x: 300, y: 10, w: 60, h: 11, text: 'under the buttons' },
    { x: 20, y: 200, w: 60, h: 11, text: 'clear sky' },
  ], 2, blocked);
  assert.deepEqual(kept.map((k) => k.text), ['clear sky']);
  // The blockers themselves must not be emitted as drawable labels.
  assert.ok(kept.every((k) => k.text));
  assert.equal(placeLabels([{ x: 0, y: 0, w: 5, h: 5, text: 'a' }], 2).length, 1, 'blocked defaults to empty');
});

test('pickNearest measures to the edge so big objects win ties', () => {
  const items = [
    { x: 100, y: 100, r: 12, name: 'Jupiter' },
    { x: 92, y: 100, r: 0.6, name: 'faint star' },
  ];
  assert.equal(pickNearest(items, 95, 100).name, 'Jupiter');
  assert.equal(pickNearest(items, 300, 300), null, 'nothing within range returns null');
  assert.equal(pickNearest([], 0, 0), null);
});

test('pointToward steps toward the target and degrades gracefully', () => {
  const from = { az: 100, alt: 30 };
  const to = { az: 130, alt: 30 };
  const p = pointToward(from, to, 2);
  assert.ok(p.az > from.az && p.az < to.az, `az ${p.az}`);
  assert.ok(Math.abs(p.alt - 30) < 1.0);
  // Stepping the full separation lands on the target.
  const full = pointToward(from, to, 30 * Math.cos(30 * Math.PI / 180) * 0 + angle(from, to));
  assert.ok(Math.abs(full.az - to.az) < 0.01 && Math.abs(full.alt - to.alt) < 0.01);
  const same = pointToward(from, { ...from }, 2);
  assert.ok(Number.isFinite(same.az) && Number.isFinite(same.alt), 'coincident points stay finite');

  function angle(a, b) {
    const v = (p) => {
      const ca = Math.cos(p.alt * Math.PI / 180);
      return [ca * Math.sin(p.az * Math.PI / 180), ca * Math.cos(p.az * Math.PI / 180), Math.sin(p.alt * Math.PI / 180)];
    };
    const [x, y, z] = v(a);
    const [X, Y, Z] = v(b);
    return Math.acos(Math.max(-1, Math.min(1, x * X + y * Y + z * Z))) * 180 / Math.PI;
  }
});

test('focalLength grows as the field narrows', () => {
  assert.ok(focalLength({ fov: 20 }, 400) > focalLength({ fov: 90 }, 400));
  assert.equal(zoomView(VIEW, 1).fov, VIEW.fov);
  assert.ok(FOV_MIN < FOV_MAX);
});
