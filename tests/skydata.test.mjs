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
  assert.ok(sky.lines.length > 300, `${sky.lines.length} polylines`);
  for (const line of sky.lines) {
    assert.ok(line.length >= 2);
    for (const [ra, dec] of line) {
      assert.ok(ra >= 0 && ra < 360, `line ra ${ra}`);
      assert.ok(dec >= -90 && dec <= 90, `line dec ${dec}`);
    }
  }
});
