// js/tonight.js — "Tonight's sky" content: meteor showers, Milky Way core
// visibility, moon phase names, and the NOAA aurora (Kp) forecast.

import { julianDate, altitudeOf } from './astro.js';

/* ================= Meteor showers =================
 * The major annual showers. Dates drift by less than a day year to year —
 * calendar windows are plenty for a dashboard. ZHR = zenith hourly rate
 * under ideal skies. */

const SHOWERS = [
  { name: 'Quadrantids', from: [12, 28], to: [1, 12], peak: [1, 3], zhr: 110 },
  { name: 'Lyrids', from: [4, 14], to: [4, 30], peak: [4, 22], zhr: 18 },
  { name: 'Eta Aquariids', from: [4, 19], to: [5, 28], peak: [5, 5], zhr: 50 },
  { name: 'S. Delta Aquariids', from: [7, 12], to: [8, 23], peak: [7, 30], zhr: 25 },
  { name: 'Perseids', from: [7, 17], to: [8, 24], peak: [8, 12], zhr: 100 },
  { name: 'Orionids', from: [10, 2], to: [11, 7], peak: [10, 21], zhr: 20 },
  { name: 'Leonids', from: [11, 6], to: [11, 30], peak: [11, 17], zhr: 15 },
  { name: 'Geminids', from: [12, 4], to: [12, 17], peak: [12, 14], zhr: 150 },
  { name: 'Ursids', from: [12, 17], to: [12, 26], peak: [12, 22], zhr: 10 },
];

const dayOfYearish = (m, d) => m * 31 + d; // monotone within a year — fine for window tests

/**
 * Showers active on a given local [month, day] (1-based month), sorted by
 * ZHR. `daysToPeak` is approximate (calendar-day arithmetic, ±1).
 */
export function activeShowers(month, day) {
  const now = dayOfYearish(month, day);
  return SHOWERS
    .filter(({ from, to }) => {
      const a = dayOfYearish(from[0], from[1]);
      const b = dayOfYearish(to[0], to[1]);
      return a <= b ? now >= a && now <= b : now >= a || now <= b; // Dec–Jan wrap
    })
    .map((s) => {
      const peakDelta = dayOfYearish(s.peak[0], s.peak[1]) - now;
      return { ...s, atPeak: Math.abs(peakDelta) <= 1, beforePeak: peakDelta > 0 };
    })
    .sort((a, b) => b.zhr - a.zhr);
}

/* ================= Milky Way core ================= */

// Galactic center (Sagittarius A*): RA 17h45.7m, Dec −28.94° (J2000).
const GC_RA = 266.42;
const GC_DEC = -28.94;

/**
 * Peak altitude of the galactic core across a set of hour instants.
 * Returns { alt, time } for the best hour, or null when the list is empty.
 */
export function milkyWayPeak(times, lat, lon) {
  let best = null;
  for (const t of times) {
    const alt = altitudeOf(GC_RA, GC_DEC, julianDate(new Date(t)), lat, lon);
    if (!best || alt > best.alt) best = { alt, time: t };
  }
  return best;
}

/* ================= Moon phase names ================= */

export function phaseName(fraction, waxing) {
  if (fraction < 0.03) return 'New Moon';
  if (fraction > 0.97) return 'Full Moon';
  if (fraction < 0.35) return waxing ? 'Waxing Crescent' : 'Waning Crescent';
  if (fraction <= 0.65) return waxing ? 'First Quarter' : 'Last Quarter';
  return waxing ? 'Waxing Gibbous' : 'Waning Gibbous';
}

/* ================= Aurora (NOAA SWPC Kp forecast) ================= */

/**
 * Max predicted Kp over the next ~24 hours from NOAA SWPC (keyless, CORS).
 * Returns { maxKp, time } or throws on network failure.
 */
export async function fetchKpForecast() {
  const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
  if (!res.ok) throw new Error(`SWPC HTTP ${res.status}`);
  const rows = await res.json();
  const now = Date.now();
  let best = null;
  for (const r of rows) {
    if (r.observed === 'observed') continue;
    const t = Date.parse(`${r.time_tag}Z`); // SWPC time_tags are UTC
    if (Number.isNaN(t) || t < now - 3 * 3600000 || t > now + 27 * 3600000) continue;
    const kp = Number(r.kp);
    if (!best || kp > best.maxKp) best = { maxKp: kp, time: t };
  }
  if (!best) throw new Error('No forecast rows');
  return best;
}

/**
 * Roughly the Kp needed for aurora to be visible at a geographic latitude.
 * Coarse (geomagnetic latitude differs from geographic) but right-shaped.
 */
export function kpNeeded(lat) {
  const a = Math.abs(lat);
  if (a >= 65) return 3;
  if (a >= 60) return 4;
  if (a >= 55) return 5;
  if (a >= 50) return 6;
  if (a >= 45) return 7;
  return 9;
}
