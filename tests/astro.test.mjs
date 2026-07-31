// Regression tests for the pure-math modules. Run with: npm test
// (node --test tests/ — no dependencies needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  julianDate, sunAltitude, moonAltitude, moonIllumination,
  visiblePlanets, nextLunations, altitudeCrossings, planetNightEvents,
} from '../js/astro.js';
import { heuristicSeeing } from '../js/weather.js';
import { scoreMetric, overallScore, verdict, band, WEIGHTS } from '../js/score.js';
import { bortleFromMpsas } from '../js/lightpollution.js';
import { activeShowers, phaseName, kpNeeded, milkyWayPeak } from '../js/tonight.js';

const NYC = { lat: 40.7128, lon: -74.0060 };

test('julianDate: J2000 epoch', () => {
  // 2000-01-01 12:00 UTC is JD 2451545.0
  assert.ok(Math.abs(julianDate(new Date(Date.UTC(2000, 0, 1, 12))) - 2451545.0) < 1e-6);
});

test('sun altitude: NYC noon high, midnight low (2026-07-31)', () => {
  const noon = sunAltitude(new Date('2026-07-31T16:00:00Z'), NYC.lat, NYC.lon);
  const midnight = sunAltitude(new Date('2026-07-31T04:30:00Z'), NYC.lat, NYC.lon);
  assert.ok(noon > 55 && noon < 75, `noon altitude ${noon}`);
  assert.ok(midnight < -20, `midnight altitude ${midnight}`);
});

test('moon illumination is a sane fraction and matches lunations', () => {
  const start = new Date('2026-07-31T00:00:00Z');
  const lunations = nextLunations(start, 45);
  const firstNew = lunations.find((l) => l.type === 'new');
  const firstFull = lunations.find((l) => l.type === 'full');
  assert.ok(firstNew, 'a new moon occurs within 45 days');
  assert.ok(firstFull, 'a full moon occurs within 45 days');
  // Self-consistency: illumination at the solved instants
  assert.ok(moonIllumination(new Date(firstNew.time)).fraction < 0.02, 'new moon is dark');
  assert.ok(moonIllumination(new Date(firstFull.time)).fraction > 0.98, 'full moon is lit');
  // Consecutive same-type events are ~29.5 days apart
  const news = lunations.filter((l) => l.type === 'new');
  if (news.length >= 2) {
    const days = (news[1].time - news[0].time) / 86400000;
    assert.ok(Math.abs(days - 29.53) < 1.2, `synodic month ≈ 29.5d, got ${days}`);
  }
});

test('moon altitude crossings produce at most a rise and set per scan-day', () => {
  const start = Date.parse('2026-07-31T04:00:00Z');
  const crossings = altitudeCrossings(
    (d) => moonAltitude(d, NYC.lat, NYC.lon), start, start + 86400000, 0,
  );
  assert.ok(crossings.length >= 1 && crossings.length <= 3, `got ${crossings.length}`);
});

test('planets: at least one of V/Ma/J/S is up at some hour of the day', () => {
  const seen = new Set();
  for (let h = 0; h < 24; h++) {
    for (const p of visiblePlanets(new Date(Date.UTC(2026, 6, 31, h)), NYC.lat, NYC.lon)) {
      seen.add(p);
    }
  }
  assert.ok(['V', 'Ma', 'J', 'S'].some((p) => seen.has(p)), [...seen].join(' '));
});

test('score table matches the spec breakpoints', () => {
  assert.equal(scoreMetric('cloud', 0), 1);
  assert.equal(scoreMetric('cloud', 80), 0);
  assert.ok(Math.abs(scoreMetric('cloud', 40) - 0.5) < 1e-9);
  assert.equal(scoreMetric('wind', 5), 1);
  assert.equal(scoreMetric('wind', 25), 0);
  assert.equal(scoreMetric('visibility', 10), 1);
  assert.equal(scoreMetric('visibility', 2), 0);
  assert.equal(scoreMetric('darkness', null, { sunAltitude: -18 }), 1);
  assert.equal(scoreMetric('darkness', null, { sunAltitude: 0 }), 0);
  assert.equal(scoreMetric('moon', null, { moonAltitude: -5, moonIllum: 1 }), 1);
  assert.equal(scoreMetric('moon', null, { moonAltitude: 30, moonIllum: 1 }), 0);
  assert.equal(scoreMetric('windChill', 50), 1);
  assert.equal(scoreMetric('windChill', 0), 0);
  assert.equal(scoreMetric('weatherCode', 0), 1);
  assert.equal(scoreMetric('weatherCode', 2), 0.6);
  assert.equal(scoreMetric('weatherCode', 3), 0.2);
  assert.equal(scoreMetric('weatherCode', 61), 0);
  assert.equal(scoreMetric('lightPollution', 2), 1);
  assert.equal(scoreMetric('lightPollution', 8), 0);
});

test('weights sum to 1.00', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
});

test('overall score: perfect night is Good, hard caps apply', () => {
  const perfect = { cloud: 0, precipProb: 0, windMph: 2, visMiles: 10, seeing: 1, transparency: 1, apparentF: 60 };
  const night = { bortle: 2, moonAltitude: -10, sunAltitude: -30, moonIllum: 0.9 };
  assert.ok(overallScore(perfect, night) >= 0.9);
  assert.ok(overallScore(perfect, { ...night, sunAltitude: 20 }) <= 0.25, 'daylight cap');
  assert.ok(overallScore({ ...perfect, cloud: 95 }, night) <= 0.2, 'cloud cap');
  assert.ok(overallScore({ ...perfect, precipProb: 75 }, night) <= 0.25, 'precip cap');
  assert.equal(verdict(0.7), 'Good To Stargaze');
  assert.equal(band(0.32), 'bad');
});

test('bortle from mpsas thresholds', () => {
  assert.equal(bortleFromMpsas(22.0), 1);
  assert.equal(bortleFromMpsas(21.9), 2);
  assert.equal(bortleFromMpsas(21.0), 4);
  assert.equal(bortleFromMpsas(20.0), 5);
  assert.equal(bortleFromMpsas(17.05), 9); // Manhattan, per the 2024 atlas
});

test('meteor showers: windows and Dec–Jan wrap', () => {
  const aug12 = activeShowers(8, 12);
  assert.ok(aug12.some((s) => s.name === 'Perseids' && s.atPeak), 'Perseids peak Aug 12');
  const jan2 = activeShowers(1, 2);
  assert.ok(jan2.some((s) => s.name === 'Quadrantids'), 'Quadrantids active Jan 2 (wraps year end)');
  const jun1 = activeShowers(6, 1);
  assert.equal(jun1.length, 0, 'no major showers June 1');
});

test('phase names', () => {
  assert.equal(phaseName(0.01, true), 'New Moon');
  assert.equal(phaseName(0.99, true), 'Full Moon');
  assert.equal(phaseName(0.2, true), 'Waxing Crescent');
  assert.equal(phaseName(0.5, false), 'Last Quarter');
  assert.equal(phaseName(0.8, false), 'Waning Gibbous');
});

test('kp thresholds fall with latitude', () => {
  assert.ok(kpNeeded(68) < kpNeeded(58));
  assert.ok(kpNeeded(58) < kpNeeded(46));
  assert.equal(kpNeeded(30), 9);
});

test('planet night events: sane fields, sorted best-first, consistent with visiblePlanets', () => {
  // The night of 2026-07-31 in NYC, ~9 PM EDT to 5 AM EDT.
  const start = Date.parse('2026-08-01T01:00:00Z');
  const end = Date.parse('2026-08-01T09:00:00Z');
  const events = planetNightEvents(start, end, NYC.lat, NYC.lon);
  assert.ok(events.length >= 1, 'at least one planet clears 5° during the night');
  for (const e of events) {
    assert.ok(e.peakAlt > 5 && e.peakAlt <= 90, `${e.name} peakAlt ${e.peakAlt}`);
    assert.ok(e.peakTime >= start && e.peakTime <= end);
    if (e.rise != null) assert.ok(e.rise >= start && e.rise <= end);
  }
  const alts = events.map((e) => e.peakAlt);
  assert.deepEqual(alts, [...alts].sort((a, b) => b - a), 'sorted best first');
  // Cross-check: each event planet is "visible" at its own peak time.
  for (const e of events) {
    assert.ok(visiblePlanets(new Date(e.peakTime), NYC.lat, NYC.lon).includes(e.abbr), e.name);
  }
});

test('shear-based seeing: jet stream wrecks it, slack jet is fine', () => {
  const calm = { cloud: 0, windMph: 3, w250: 50, w500: 25 };
  const jet = { cloud: 0, windMph: 3, w250: 220, w500: 120 };
  assert.ok(heuristicSeeing(calm) > 0.55, `calm ${heuristicSeeing(calm)}`);
  assert.ok(heuristicSeeing(jet) < 0.2, `jet ${heuristicSeeing(jet)}`);
  // Without upper-air data it falls back to the cloud+wind heuristic
  const legacy = { cloud: 20, windMph: 6 };
  assert.ok(Math.abs(heuristicSeeing(legacy) - (1 - 0.2 - 0.1)) < 1e-9);
});

test('milky way core: transits ~south and higher from lower latitudes', () => {
  // Galactic core culminates higher from Key West than from NYC.
  const times = [];
  for (let h = 0; h < 24; h++) times.push(Date.UTC(2026, 6, 31, h));
  const nyc = milkyWayPeak(times, 40.71, -74.0);
  const keyWest = milkyWayPeak(times, 24.55, -81.8);
  assert.ok(keyWest.alt > nyc.alt, `${keyWest.alt} > ${nyc.alt}`);
  assert.ok(nyc.alt > 10 && nyc.alt < 30, `NYC July core peak ≈ 20°, got ${nyc.alt}`);
});
