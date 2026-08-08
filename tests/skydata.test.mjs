import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sky = JSON.parse(readFileSync(new URL('../data/sky.json', import.meta.url), 'utf8'));

// Catalogue rows are [ra, dec, mag, bv, properName?, designation?]. Slots 4
// and 5 are optional and a bare 0 in slot 4 means "designation but no proper
// name", so index arithmetic here has to match js/skymap.js#starDrawList.
const NAME = 4;
const DESIG = 5;

test('star catalog has ~1600 stars, all fields in range, brightest first', () => {
  assert.ok(sky.stars.length > 1200 && sky.stars.length < 2500, `${sky.stars.length} stars`);
  let prevMag = -Infinity;
  for (const s of sky.stars) {
    assert.ok(s.length >= 4 && s.length <= 6, `row width ${s.length}`);
    assert.ok(s[0] >= 0 && s[0] < 360, `ra ${s[0]}`);
    assert.ok(s[1] >= -90 && s[1] <= 90, `dec ${s[1]}`);
    assert.ok(s[2] <= 5.05, `mag ${s[2]}`);
    assert.ok(s[2] >= prevMag, 'sorted brightest-first');
    prevMag = s[2];
    assert.ok(s[3] >= -0.4 && s[3] <= 2.5, `B−V ${s[3]} out of table range`);
  }
});

test('colour indices are populated and physically spread', () => {
  const withColour = sky.stars.filter((s) => s[3] !== 0);
  assert.ok(withColour.length > sky.stars.length * 0.9, `only ${withColour.length} stars carry B−V`);
  assert.ok(sky.stars.some((s) => s[3] < -0.1), 'no hot blue stars');
  assert.ok(sky.stars.some((s) => s[3] > 1.4), 'no cool red stars');
  // Spot-check well-known colours so a bad column mapping cannot slip through.
  const byName = new Map(sky.stars.filter((s) => s[NAME]).map((s) => [s[NAME], s]));
  assert.ok(byName.get('Betelgeuse')[3] > 1.3, 'Betelgeuse must be red');
  assert.ok(byName.get('Rigel')[3] < 0.1, 'Rigel must be blue-white');
  assert.ok(Math.abs(byName.get('Vega')[3]) < 0.15, 'Vega must be near-white');
});

test('iconic bright stars are named, and names stay a curated set', () => {
  const names = new Set(sky.stars.filter((s) => s[NAME]).map((s) => s[NAME]));
  for (const want of ['Sirius', 'Vega', 'Arcturus', 'Betelgeuse', 'Polaris', 'Antares']) {
    assert.ok(names.has(want), `missing ${want}`);
  }
  assert.ok(names.size >= 40 && names.size <= 200, `${names.size} named stars`);
});

test('Bayer designations cover most stars and are well formed', () => {
  const desig = sky.stars.filter((s) => s[DESIG]);
  assert.ok(desig.length > sky.stars.length * 0.7, `only ${desig.length} designated`);
  for (const s of desig) {
    assert.match(s[DESIG], /^\S+ [A-Z][A-Za-z]{2}$/, `bad designation "${s[DESIG]}"`);
  }
  const byName = new Map(sky.stars.filter((s) => s[NAME]).map((s) => [s[NAME], s]));
  assert.equal(byName.get('Sirius')[DESIG], 'α CMa');
  assert.equal(byName.get('Betelgeuse')[DESIG], 'α Ori');
});

test('constellation polylines cover the sky and are in range', () => {
  assert.ok(sky.lines.length > 120, `${sky.lines.length} polylines`);
  for (const line of sky.lines) {
    assert.ok(line.length >= 2);
    for (const [ra, dec] of line) {
      assert.ok(ra >= 0 && ra < 360, `line ra ${ra}`);
      assert.ok(dec >= -90 && dec <= 90, `line dec ${dec}`);
    }
  }
});

test('all 88 constellations have a label anchor, rank and IAU abbreviation', () => {
  assert.ok(sky.consts.length >= 88, `${sky.consts.length} constellation anchors`);
  const abbrs = new Set();
  for (const [ra, dec, name, rank, abbr] of sky.consts) {
    assert.ok(ra >= 0 && ra < 360, `const ra ${ra}`);
    assert.ok(dec >= -90 && dec <= 90, `const dec ${dec}`);
    assert.ok(typeof name === 'string' && name.length > 2, `const name ${name}`);
    assert.ok(rank >= 1 && rank <= 3, `rank ${rank} for ${name}`);
    assert.match(abbr, /^[A-Z][A-Za-z]{2}$/, `abbr ${abbr}`);
    abbrs.add(abbr);
  }
  assert.ok(sky.consts.some((c) => c[2] === 'Orion' && c[3] === 1), 'Orion should be a rank-1 label');
  // Every star designation must resolve against the anchor list, else a
  // tapped star cannot name its constellation.
  for (const s of sky.stars) {
    if (!s[DESIG]) continue;
    const abbr = s[DESIG].split(' ').pop();
    assert.ok(abbrs.has(abbr), `designation "${s[DESIG]}" has no constellation anchor`);
  }
});

test('Milky Way outlines are closed, ordered faint→bright, and lightweight', () => {
  assert.ok(sky.mw.length >= 3, `${sky.mw.length} brightness levels`);
  let total = 0;
  for (const level of sky.mw) {
    assert.ok(level.length >= 1);
    for (const ring of level) {
      assert.ok(ring.length >= 8, `ring of ${ring.length} points is degenerate`);
      total += ring.length;
      for (const [ra, dec] of ring) {
        assert.ok(ra >= 0 && ra < 360, `mw ra ${ra}`);
        assert.ok(dec >= -90 && dec <= 90, `mw dec ${dec}`);
      }
    }
  }
  // Simplification has to keep this cheap enough to transform every frame.
  assert.ok(total < 4000, `${total} Milky Way points is too many to draw at 60fps`);
  // The brightest contour should sit near the galactic centre (RA ~266°, dec ~−29°).
  const bright = sky.mw[sky.mw.length - 1].flat();
  const mean = bright.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map((v) => v / bright.length);
  assert.ok(mean[0] > 220 && mean[0] < 320, `brightest MW level centred at RA ${mean[0].toFixed(0)}`);
  assert.ok(mean[1] < 10, `brightest MW level centred at dec ${mean[1].toFixed(0)}`);
});

test('no two proper-named stars within 0.1° (double-label guard)', () => {
  const named = sky.stars.filter((s) => s[NAME]);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const cosD = Math.cos((named[i][1] * Math.PI) / 180);
      let dRa = Math.abs(named[i][0] - named[j][0]);
      if (dRa > 180) dRa = 360 - dRa;
      const dist = Math.hypot(dRa * cosD, named[i][1] - named[j][1]);
      assert.ok(dist > 0.1, `"${named[i][NAME]}" and "${named[j][NAME]}" are ${dist.toFixed(3)}° apart`);
    }
  }
});

test('payload stays small enough to lazy-fetch on a phone', () => {
  const bytes = readFileSync(new URL('../data/sky.json', import.meta.url)).length;
  assert.ok(bytes < 160_000, `sky.json is ${(bytes / 1024).toFixed(0)}KB`);
});
