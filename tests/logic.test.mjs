// Tests for the pure app-logic module — this is where production bugs have
// actually lived, so these are regression-heavy. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseShareCoords, groupByLocalDate, nightHoursOf,
  bestRun, bestWindowIn, buildICS, icsEscape, nightCloudMean, dewRiskStart,
  shouldAutoEnterAR, interpolateHours,
} from '../js/logic.js';

/* ================= Share-param parsing ================= */

test('parseShareCoords: absent params never read as (0,0) — the regression', () => {
  assert.equal(parseShareCoords(''), null);
  assert.equal(parseShareCoords('?'), null);
  assert.equal(parseShareCoords('?foo=bar'), null);
  assert.equal(parseShareCoords('?lat=&lon='), null); // Number('') === 0 trap
  assert.equal(parseShareCoords('?lat=40.7'), null); // one without the other
});

test('parseShareCoords: valid, bounds, and name handling', () => {
  const ok = parseShareCoords('?lat=41.6626&lon=-77.8261&name=Cherry%20Springs');
  assert.deepEqual(ok, { lat: 41.6626, lon: -77.8261, name: 'Cherry Springs' });
  assert.equal(parseShareCoords('?lat=91&lon=0'), null);
  assert.equal(parseShareCoords('?lat=0&lon=181'), null);
  assert.equal(parseShareCoords('?lat=abc&lon=1'), null);
  // (0,0) is a legal place when explicitly given
  assert.equal(parseShareCoords('?lat=0&lon=0').lat, 0);
  // Missing name falls back to coordinates
  assert.equal(parseShareCoords('?lat=1.23456&lon=2.3').name, '1.235, 2.300');
  // Long names are clipped
  assert.equal(parseShareCoords(`?lat=1&lon=2&name=${'x'.repeat(99)}`).name.length, 60);
});

/* ================= Day grouping (incl. DST) ================= */

function hourlyEpochs(startUtcMs, count) {
  return Array.from({ length: count }, (_, i) => startUtcMs + i * 3600000);
}

function isoDateIn(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return (ms) => fmt.format(ms);
}

test('groupByLocalDate: normal day has 24 hours', () => {
  // 2026-07-15 00:00 EDT = 04:00 UTC
  const times = hourlyEpochs(Date.parse('2026-07-15T04:00:00Z'), 48);
  const groups = groupByLocalDate(times, isoDateIn('America/New_York'));
  assert.equal(groups.get('2026-07-15').length, 24);
  assert.equal(groups.get('2026-07-16').length, 24);
});

test('groupByLocalDate: DST fall-back day has 25 hours (US, Nov 1 2026)', () => {
  // 2026-10-31 00:00 EDT = 04:00 UTC; Nov 1 2026 is the fall-back day.
  const times = hourlyEpochs(Date.parse('2026-10-31T04:00:00Z'), 72);
  const groups = groupByLocalDate(times, isoDateIn('America/New_York'));
  assert.equal(groups.get('2026-10-31').length, 24);
  assert.equal(groups.get('2026-11-01').length, 25, 'fall-back day gains an hour');
});

test('groupByLocalDate: DST spring-forward day has 23 hours (US, Mar 8 2026)', () => {
  // 2026-03-07 00:00 EST = 05:00 UTC; Mar 8 2026 is the spring-forward day.
  const times = hourlyEpochs(Date.parse('2026-03-07T05:00:00Z'), 72);
  const groups = groupByLocalDate(times, isoDateIn('America/New_York'));
  assert.equal(groups.get('2026-03-08').length, 23, 'spring-forward day loses an hour');
});

/* ================= Night windows ================= */

const H = 3600000;
const mkHours = (startMs, specs) =>
  specs.map((s, i) => ({ time: startMs + i * H, score: s.score, sunAlt: s.sunAlt ?? -10 }));

test('nightHoursOf: [noon, noon+24h) with sun below horizon', () => {
  const noon = Date.parse('2026-08-01T16:00:00Z');
  const hours = [
    { time: noon - H, sunAlt: -5 }, // before window
    { time: noon + 2 * H, sunAlt: 30 }, // daylight
    { time: noon + 10 * H, sunAlt: -20 }, // night ✓
    { time: noon + 15 * H, sunAlt: -30 }, // night, past midnight ✓
    { time: noon + 24 * H, sunAlt: -10 }, // next window
  ];
  const night = nightHoursOf(hours, noon);
  assert.deepEqual(night.map((h) => h.time), [noon + 10 * H, noon + 15 * H]);
});

test('bestRun: longest contiguous run wins; gaps break runs', () => {
  const t0 = 0;
  const hours = mkHours(t0, [
    { score: 0.7 }, { score: 0.7 }, // run of 2
    { score: 0.1 },
    { score: 0.8 }, { score: 0.9 }, { score: 0.7 }, // run of 3 ← winner
  ]);
  assert.equal(bestRun(hours, 0.66).length, 3);
  // A time gap (missing hour) splits an otherwise-qualifying run
  const gapped = [
    { time: 0, score: 0.9 }, { time: H, score: 0.9 },
    { time: 3 * H, score: 0.9 }, // 2h jump
  ];
  assert.equal(bestRun(gapped, 0.66).length, 2);
  assert.equal(bestRun(hours, 0.95), null);
});

test('bestWindowIn: prefers good, falls back to marginal, null when hopeless', () => {
  const good = mkHours(0, [{ score: 0.7 }, { score: 0.7 }, { score: 0.4 }]);
  assert.equal(bestWindowIn(good).level, 'good');
  const marginal = mkHours(0, [{ score: 0.4 }, { score: 0.5 }]);
  assert.equal(bestWindowIn(marginal).level, 'marginal');
  assert.equal(bestWindowIn(mkHours(0, [{ score: 0.1 }])), null);
});

/* ================= ICS ================= */

test('buildICS: valid structure, UTC stamps, escaped text, CRLF', () => {
  const ics = buildICS({
    startMs: Date.parse('2026-08-01T01:00:00Z'),
    endMs: Date.parse('2026-08-01T08:00:00Z'),
    level: 'good',
    name: 'Cherry Springs, PA; camp',
    url: 'https://example.com/starcast/',
    nowMs: Date.parse('2026-07-31T23:00:00Z'),
  });
  const lines = ics.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 1], 'END:VCALENDAR');
  assert.ok(lines.includes('DTSTART:20260801T010000Z'));
  assert.ok(lines.includes('DTEND:20260801T080000Z'));
  assert.ok(lines.includes('DTSTAMP:20260731T230000Z'));
  assert.ok(ics.includes('LOCATION:Cherry Springs\\, PA\\; camp'), 'commas/semicolons escaped');
  assert.ok(!ics.includes('\n\n'), 'no bare blank lines');
});

test('icsEscape covers backslash too', () => {
  assert.equal(icsEscape('a\\b,c;d'), 'a\\\\b\\,c\\;d');
});

/* ================= Dew risk ================= */

test('dewRiskStart: finds the first risky hour, grades severity, handles metric', () => {
  const t0 = Date.parse('2026-08-01T02:00:00Z');
  const night = [
    { time: t0, temp: 70, dewPoint: 60 }, // spread 10°F — dry
    { time: t0 + H, temp: 66, dewPoint: 63 }, // spread 3°F — dew possible
    { time: t0 + 2 * H, temp: 64, dewPoint: 63 }, // spread 1°F — heavy
  ];
  const risk = dewRiskStart(night, 1);
  assert.deepEqual(risk, { time: t0 + H, heavy: false });
  // Metric records: 2°C spread = 3.6°F → "possible", not "heavy"
  const metricNight = [{ time: t0, temp: 14, dewPoint: 12 }];
  assert.deepEqual(dewRiskStart(metricNight, 1.8), { time: t0, heavy: false });
  // Dry night → null
  assert.equal(dewRiskStart([{ time: t0, temp: 70, dewPoint: 50 }], 1), null);
});

/* ================= Spot comparison ================= */

test('nightCloudMean: averages only night hours in the next 14h', () => {
  const now = Date.parse('2026-08-01T00:00:00Z');
  const cloudHours = [
    { time: now + 1 * H, cloud: 10 },
    { time: now + 2 * H, cloud: 30 }, // "daytime" per isNight below
    { time: now + 3 * H, cloud: 50 },
    { time: now + 20 * H, cloud: 100 }, // beyond 14h
  ];
  const isNight = (t) => t !== now + 2 * H;
  assert.equal(nightCloudMean(cloudHours, now, isNight), 30); // (10+50)/2
  assert.equal(nightCloudMean(cloudHours, now, () => false), null);
});

/* ================= AR auto-entry ================= */

test('shouldAutoEnterAR: defaults on, each gate can veto', () => {
  const ok = { arAuto: undefined, arActive: false, latFinite: true, hasSensorApi: true, coarsePointer: true };
  assert.equal(shouldAutoEnterAR(ok), true); // absent pref = on (existing users)
  assert.equal(shouldAutoEnterAR({ ...ok, arAuto: true }), true);
  assert.equal(shouldAutoEnterAR({ ...ok, arAuto: false }), false); // user turned it off
  assert.equal(shouldAutoEnterAR({ ...ok, arActive: true }), false); // already in AR
  assert.equal(shouldAutoEnterAR({ ...ok, latFinite: false }), false); // no location yet
  assert.equal(shouldAutoEnterAR({ ...ok, hasSensorApi: false }), false);
  assert.equal(shouldAutoEnterAR({ ...ok, coarsePointer: false }), false); // desktop
});

/* ================= interpolateHours (minute-level scrubbing) ================= */

test('interpolateHours lerps numerics, snaps categoricals, computes exact time', () => {
  const a = { time: 1000 * 3600e3, cloud: 40, windMph: 10, weatherCode: 2, isDay: 0,
              planets: ['V'], moonWaxing: true, seeingIsEstimate: true, score: 0.9 };
  const b = { time: 1001 * 3600e3, cloud: 60, windMph: 20, weatherCode: 3, isDay: 1,
              planets: ['V', 'J'], moonWaxing: true, seeingIsEstimate: true, score: 0.1 };
  const h = interpolateHours(a, b, 0.25);
  assert.equal(h.cloud, 45);
  assert.equal(h.windMph, 12.5);
  assert.equal(h.time, a.time + 0.25 * 3600e3);
  assert.equal(h.weatherCode, 2);          // nearest at 0.25 → a
  assert.deepEqual(h.planets, ['V']);
  assert.equal(interpolateHours(a, b, 0.75).weatherCode, 3); // nearest → b
  assert.equal(h.score, undefined);        // caller rescores
});

test('interpolateHours: frac 0/1 identity on numerics', () => {
  const a = { time: 0, cloud: 40 }, b = { time: 3600e3, cloud: 60 };
  assert.equal(interpolateHours(a, b, 0).cloud, 40);
  assert.equal(interpolateHours(a, b, 1).cloud, 60);
});

test('interpolateHours: one-sided and missing fields never produce NaN', () => {
  const a = { time: 0, cloud: 40, kp: 3 };           // kp only on a
  const b = { time: 3600e3, cloud: 60, aod: 0.2 };   // aod only on b
  const h = interpolateHours(a, b, 0.5);
  assert.equal(h.kp, 3);
  assert.equal(h.aod, 0.2);
  for (const v of Object.values(h)) assert.ok(typeof v !== 'number' || Number.isFinite(v));
});

test('interpolateHours clamps at forecast end (no b)', () => {
  const a = { time: 0, cloud: 40, weatherCode: 2 };
  const h = interpolateHours(a, null, 0.5);
  assert.equal(h.cloud, 40);
  assert.equal(h.weatherCode, 2);
  assert.equal(h.time, 0.5 * 3600e3);      // clock still advances
});
