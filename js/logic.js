// js/logic.js — pure, DOM-free app logic, extracted so Node can test the
// code where bugs have actually lived (URL parsing, night-window math,
// day grouping, ICS generation).

/**
 * Parse ?lat=..&lon=..&name=.. share params. Returns { lat, lon, name }
 * or null when absent/invalid. NOTE: Number(null) and Number('') are both
 * 0 — a missing param must never read as coordinates (regression: the app
 * once relocated itself to 0°N 0°E because of exactly this).
 */
export function parseShareCoords(search) {
  const p = new URLSearchParams(search);
  const latStr = p.get('lat');
  const lonStr = p.get('lon');
  if (!latStr || !lonStr) return null;
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    name: (p.get('name') || '').slice(0, 60) || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
  };
}

/**
 * Group hour timestamps by local calendar date. `isoDateOf` maps epoch-ms
 * to 'YYYY-MM-DD' in the target timezone (Intl-backed in the app). Returns
 * Map of date-key → array of indices. DST days come out with 23 or 25
 * entries, which is correct — the timeline renders what the day really had.
 */
export function groupByLocalDate(times, isoDateOf) {
  const map = new Map();
  times.forEach((t, i) => {
    const key = isoDateOf(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  });
  return map;
}

/**
 * The hour records belonging to "the night starting at `noonMs`": within
 * [noon, noon + 24h) with the sun below the horizon. Lets an evening
 * window cross midnight instead of being chopped at 12:00 AM.
 */
export function nightHoursOf(hourRecords, noonMs) {
  return hourRecords.filter(
    (h) => h.time >= noonMs && h.time < noonMs + 86400000 && h.sunAlt < 0,
  );
}

/** Longest contiguous (hour-adjacent) run of records with score ≥ minScore. */
export function bestRun(hours, minScore) {
  let best = null;
  let run = [];
  const flush = () => {
    if (run.length && (!best || run.length > best.length)) best = run;
    run = [];
  };
  for (const h of hours) {
    if (h.score >= minScore && (run.length === 0 || h.time - run[run.length - 1].time === 3600000)) {
      run.push(h);
    } else {
      flush();
      if (h.score >= minScore) run = [h];
    }
  }
  flush();
  return best;
}

/** Best window of a night: a good (≥0.66) run, else a marginal (≥0.33) one. */
export function bestWindowIn(nightHrs) {
  const good = bestRun(nightHrs, 0.66);
  const win = good || bestRun(nightHrs, 0.33);
  return win ? { hours: win, level: good ? 'good' : 'marginal' } : null;
}

/** Epoch-ms → iCalendar UTC stamp, e.g. 20260801T010000Z. */
export function icsStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escape iCalendar text values (commas, semicolons, backslashes). */
export function icsEscape(s) {
  return String(s).replace(/([,;\\])/g, '\\$1');
}

/** A single-event VCALENDAR for a stargazing window. CRLF line endings. */
export function buildICS({ startMs, endMs, level, name, url, nowMs }) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Starcast//EN',
    'BEGIN:VEVENT',
    `UID:starcast-${startMs}@starcast`,
    `DTSTAMP:${icsStamp(nowMs)}`,
    `DTSTART:${icsStamp(startMs)}`,
    `DTEND:${icsStamp(endMs)}`,
    `SUMMARY:${icsEscape(`Stargazing — ${level} window (Starcast)`)}`,
    `DESCRIPTION:${icsEscape(`Forecast ${level} stargazing window at ${name}. ${url}`)}`,
    `LOCATION:${icsEscape(name)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * First night hour where dew on optics becomes likely: temp−dewpoint
 * spread under 4 °F ("dew possible"), under 2.5 °F ("heavy dew likely").
 * `spreadToF` converts the records' display-unit spread to °F (1.8 when
 * metric). Returns { time, heavy } or null for a dry night.
 */
export function dewRiskStart(nightHrs, spreadToF) {
  for (const h of nightHrs) {
    const spreadF = (h.temp - h.dewPoint) * spreadToF;
    if (spreadF < 4) return { time: h.time, heavy: spreadF < 2.5 };
  }
  return null;
}

/**
 * Mean cloud cover over a night, for comparing saved spots. `cloudHours` is
 * [{ time, cloud }], `isNight` decides per-timestamp (sun-altitude test in
 * the app). Looks at [fromMs, fromMs + 14h]. Returns null when the span has
 * no night hours (polar day, or data ran out).
 */
export function nightCloudMean(cloudHours, fromMs, isNight) {
  const night = cloudHours.filter(
    (h) => h.time >= fromMs && h.time <= fromMs + 14 * 3600000 && isNight(h.time),
  );
  if (!night.length) return null;
  return night.reduce((a, h) => a + h.cloud, 0) / night.length;
}

/**
 * Whether the Sky tab should enter AR tracking on its own (no tap). Default
 * is ON — `arAuto` only vetoes when the user explicitly toggled AR off (we
 * persist false at that moment). The other gates keep auto-entry silent and
 * sane: never re-enter over an active session, never before the location is
 * known (declination needs it), never without a sensor API, and never on
 * fine-pointer (desktop) devices where the no-sensor toast would just nag.
 */
export function shouldAutoEnterAR(ctx) {
  return ctx.arAuto !== false
    && !ctx.arActive
    && ctx.latFinite === true
    && ctx.hasSensorApi === true
    && ctx.coarsePointer === true;
}
