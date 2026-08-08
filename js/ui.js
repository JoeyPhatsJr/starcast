// js/ui.js — all DOM rendering. Reads state, writes DOM; no fetching.
//
// Scrub performance contract: renderTiles/renderBanner/updatePlayhead only
// touch textContent / className / small innerHTML swaps on pre-existing
// nodes, so scrubbing the timeline stays cheap. Only day switches and data
// refreshes rebuild nodes (segments, tabs, charts).

import { scoreMetric, verdict, band, WEIGHTS, overallScore } from './score.js';
import { activeShowers, milkyWayPeak, phaseName, kpNeeded } from './tonight.js';
import { planetNightEvents, julianDate, sunAltitude, skyBodies, moonIllumination } from './astro.js';
import { nightHoursOf, bestWindowIn, dewRiskStart, interpolateHours } from './logic.js';
import {
  project, unproject, horizonY, focalLength, frameContext, starDrawList, lineDrawList,
  polygonDrawList, gridDrawList, constellationLabelList, labelMagLimit, placeLabels,
  pickNearest, pointToward, magToRadius, toRgba, cardinalName, CARDINALS,
} from './skymap.js';

const $ = (id) => document.getElementById(id);

/* ================= Time formatting =================
 * Every user-visible time uses the LOCATION's IANA timezone (from
 * Open-Meteo), never the browser's. Formatters are cached — Intl
 * construction is expensive and scrubbing calls these constantly. */

const fmtCache = new Map();
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts);
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }));
  }
  return fmtCache.get(key);
}

export function fmtTime(ms, tz) {
  return fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(ms);
}
export function fmtWeekdayShort(ms, tz) {
  return fmt(tz, { weekday: 'short' }).format(ms);
}
export function fmtWeekdayLong(ms, tz) {
  return fmt(tz, { weekday: 'long' }).format(ms);
}
export function fmtISODate(ms, tz) {
  // en-CA yields YYYY-MM-DD
  const key = tz + ':iso';
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return fmtCache.get(key).format(ms);
}
export function localHour(ms, tz) {
  return parseInt(fmt(tz, { hour: '2-digit', hourCycle: 'h23' }).format(ms), 10);
}

/* ================= Selection helper ================= */

/** Record at `minute` past global hour `gi`, interpolated and rescored — the
 * ONE code path for sub-hour records, so the banner, tiles, and score bar can
 * never disagree about what a given instant scores. */
function scoredRecordAt(state, gi, minute) {
  const a = state.hours[gi];
  if (!minute) return a;
  // Global successor — crosses day/DST boundaries; null at forecast end (clamps).
  const h = interpolateHours(a, state.hours[gi + 1] || null, minute / 60);
  h.score = overallScore(h, {
    bortle: state.prefs.bortle,
    moonAltitude: h.moonAlt,
    sunAltitude: h.sunAlt,
    moonIllum: h.moonIllum,
  });
  return h;
}

export function getSelectedHour(state) {
  const day = state.days[state.selectedDay];
  if (!day || !day.hourIndices.length) return null;
  const pos = Math.min(state.selectedHour, day.hourIndices.length - 1);
  return scoredRecordAt(state, day.hourIndices[pos], state.selectedMinute || 0);
}

/* ================= Star field ================= */

export function initStars() {
  const canvas = $('stars');
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    // Field of ~140 faint stars with a slight blue-white color variance…
    for (let i = 0; i < 140; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 0.4 + Math.random() * 0.7;
      ctx.globalAlpha = 0.2 + Math.random() * 0.6;
      ctx.fillStyle = Math.random() < 0.3 ? '#cfdcf5' : '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // …plus a dozen brighter ones with a soft glow (still a single static
    // paint — no animation loop, no battery cost).
    ctx.shadowColor = 'rgba(210, 225, 255, 0.9)';
    for (let i = 0; i < 12; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      ctx.globalAlpha = 0.55 + Math.random() * 0.35;
      ctx.shadowBlur = 3 + Math.random() * 5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + Math.random() * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };
  draw();
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 150);
  });
}

/* ================= Weather icons =================
 * Simple two-color inline SVGs, one per WMO bucket. */

const ICON_SUN = '<circle cx="12" cy="12" r="4.2" fill="#f7d774"/><g stroke="#f7d774" stroke-width="1.6" stroke-linecap="round"><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/></g>';
const ICON_MOON = '<path d="M19.5 14.2A8 8 0 0 1 9.8 4.5 8 8 0 1 0 19.5 14.2Z" fill="#e8ecf5"/>';
const ICON_CLOUD = '<path d="M7 18.5h9.6a3.8 3.8 0 0 0 .6-7.55A5.6 5.6 0 0 0 6.3 9.6 4.4 4.4 0 0 0 7 18.5Z" fill="#cfd8ea"/>';
const CLOUD_FRONT = '<path d="M8 20h8.6a3.4 3.4 0 0 0 .55-6.75A5 5 0 0 0 7.4 12 4 4 0 0 0 8 20Z" fill="#cfd8ea"/>';
const ICON_SUN_CLOUD = '<circle cx="15.5" cy="8" r="3.4" fill="#f7d774"/><g stroke="#f7d774" stroke-width="1.3" stroke-linecap="round"><path d="M15.5 2.6v1.8M20.9 8h-1.8M19.3 4.2l-1.3 1.3M11.7 4.2 13 5.5"/></g>' + CLOUD_FRONT;
const ICON_MOON_CLOUD = '<path d="M19.5 9.4A5.2 5.2 0 0 1 13.2 3a5.2 5.2 0 1 0 6.3 6.4Z" fill="#e8ecf5"/>' + CLOUD_FRONT;
const ICON_FOG = '<path d="M7 14.5h9.6a3.8 3.8 0 0 0 .6-7.55A5.6 5.6 0 0 0 6.3 5.6 4.4 4.4 0 0 0 7 14.5Z" fill="#cfd8ea"/><g stroke="#9aa7c4" stroke-width="1.5" stroke-linecap="round"><path d="M5 18h13M7 21h9"/></g>';
const RAIN_CLOUD = '<path d="M7 15h9.6a3.8 3.8 0 0 0 .6-7.55A5.6 5.6 0 0 0 6.3 6.1 4.4 4.4 0 0 0 7 15Z" fill="#cfd8ea"/>';
const ICON_RAIN = RAIN_CLOUD + '<g stroke="#6ea8ff" stroke-width="1.7" stroke-linecap="round"><path d="M8.5 17.5 7.5 20.5M12.5 17.5l-1 3M16.5 17.5l-1 3"/></g>';
const ICON_SNOW = RAIN_CLOUD + '<g fill="#e8ecf5"><circle cx="8.5" cy="18.5" r="1.15"/><circle cx="12.5" cy="20.5" r="1.15"/><circle cx="16.5" cy="18.5" r="1.15"/></g>';
const ICON_STORM = RAIN_CLOUD + '<path d="M13 14.5 9.6 19.5h2.4L10.8 23l4.6-5.6h-2.6l1.6-2.9Z" fill="#f7d774"/>';

function wrapIcon(inner, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

export function weatherIcon(code, isDay, size = 34) {
  let inner;
  if (code === 0 || code === 1) inner = isDay ? ICON_SUN : ICON_MOON;
  else if (code === 2) inner = isDay ? ICON_SUN_CLOUD : ICON_MOON_CLOUD;
  else if (code === 3) inner = ICON_CLOUD;
  else if (code >= 45 && code <= 48) inner = ICON_FOG;
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) inner = ICON_SNOW;
  else if (code >= 95) inner = ICON_STORM;
  else if (code >= 51) inner = ICON_RAIN; // drizzle / rain / showers
  else inner = ICON_CLOUD;
  return wrapIcon(inner, size);
}

const WMO_DESC = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Icy fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 56: 'Frz. drizzle', 57: 'Frz. drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Frz. rain', 67: 'Frz. rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

/* ================= Moon phase SVG =================
 * A light disc with the dark portion overlaid as (semicircle arc +
 * half-ellipse terminator). The terminator's semi-minor axis is
 * r·|2f−1|; it bulges toward the lit side for crescents and into the
 * dark side for gibbous phases. Waxing lights the RIGHT side. */

export function moonSVG(fraction, waxing, size = 26) {
  const r = 12;
  const c = 13;
  const rx = Math.max(0.01, r * Math.abs(2 * fraction - 1));
  let dark;
  if (waxing) {
    // Dark on the left: left semicircle down, then terminator back up.
    const sweep = fraction < 0.5 ? 0 : 1;
    dark = `M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} A ${rx} ${r} 0 0 ${sweep} ${c} ${c - r} Z`;
  } else {
    // Dark on the right: right semicircle down, then terminator back up.
    const sweep = fraction < 0.5 ? 1 : 0;
    dark = `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx} ${r} 0 0 ${sweep} ${c} ${c - r} Z`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="#e9edf6"/>` +
    `<path d="${dark}" fill="#22304f"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>` +
    `</svg>`;
}

/* ================= Tiles ================= */

function tileParts(id) {
  const root = $(id);
  return {
    root,
    value: root.querySelector('.t-value'),
    sub: root.querySelector('.t-sub'),
  };
}

function setTileBand(root, score) {
  root.className = `tile band-${band(score)}`;
}

export function renderTiles(state) {
  const h = getSelectedHour(state);
  if (!h) return;
  const day = state.days[state.selectedDay];
  const tz = state.prefs.tz;
  const metric = state.prefs.units === 'metric';
  const ctx = {
    bortle: state.prefs.bortle,
    moonAltitude: h.moonAlt,
    sunAltitude: h.sunAlt,
    moonIllum: h.moonIllum,
  };

  // Weather
  {
    const t = tileParts('tile-weather');
    setTileBand(t.root, scoreMetric('weatherCode', h.weatherCode));
    t.value.innerHTML = weatherIcon(h.weatherCode, h.isDay === 1);
    t.sub.textContent = WMO_DESC[h.weatherCode] || 'Cloudy';
  }

  // Sun Times — informational, always olive
  {
    const t = tileParts('tile-suntimes');
    t.root.className = 'tile band-marginal';
    const rows = t.value.querySelectorAll('.sunrow');
    rows[0].textContent = day.sunrise != null ? `↑ ${fmtTime(day.sunrise, tz)}` : '↑ —';
    rows[1].textContent = day.sunset != null ? `↓ ${fmtTime(day.sunset, tz)}` : '↓ —';
  }

  // Visibility
  {
    const t = tileParts('tile-visibility');
    setTileBand(t.root, scoreMetric('visibility', h.visMiles));
    t.value.textContent = String(Math.round(h.visibility));
    t.sub.textContent = metric ? 'km' : 'miles';
  }

  // Wind Chill
  {
    const t = tileParts('tile-windchill');
    setTileBand(t.root, scoreMetric('windChill', h.apparentF));
    t.value.textContent = `${Math.round(h.apparent)}°`;
    t.sub.textContent = `Dew Point: ${Math.round(h.dewPoint)}°`;
  }

  // Wind
  {
    const t = tileParts('tile-wind');
    setTileBand(t.root, scoreMetric('wind', h.windMph));
    t.value.textContent = String(Math.round(h.wind));
    t.sub.textContent = metric ? 'km/h' : 'mph';
  }

  // Precip Prob
  {
    const t = tileParts('tile-precip');
    setTileBand(t.root, scoreMetric('precip', h.precipProb));
    t.value.textContent = `${Math.round(h.precipProb)}%`;
    t.sub.textContent = 'chance';
  }

  // Cloud Cover
  {
    const t = tileParts('tile-cloud');
    setTileBand(t.root, scoreMetric('cloud', h.cloud));
    t.value.textContent = `${Math.round(h.cloud)}%`;
    t.sub.textContent = `L ${Math.round(h.cloudLow)} · M ${Math.round(h.cloudMid)} · H ${Math.round(h.cloudHigh)}`;
  }

  // Seeing / Transparency (with "est." marker when heuristic)
  const est = h.seeingIsEstimate ? '<sup class="est">est.</sup>' : '';
  {
    const t = tileParts('tile-seeing');
    setTileBand(t.root, scoreMetric('seeing', h.seeing));
    t.value.innerHTML = h.seeing.toFixed(1) + est;
    t.sub.textContent = h.seeingIsEstimate ? 'estimated' : '7Timer';
  }
  {
    const t = tileParts('tile-transparency');
    setTileBand(t.root, scoreMetric('transparency', h.transparency));
    t.value.innerHTML = h.transparency.toFixed(1) + est;
    t.sub.textContent = h.seeingIsEstimate ? 'estimated' : '7Timer';
  }

  // Moon
  {
    const t = tileParts('tile-moon');
    setTileBand(t.root, scoreMetric('moon', null, ctx));
    t.value.querySelector('.moon-gfx').innerHTML = moonSVG(h.moonIllum, h.moonWaxing);
    t.value.querySelector('.moon-pct').textContent = `${Math.round(h.moonIllum * 100)}%`;
    t.sub.textContent = h.moonAlt < 0 ? 'Below horizon' : phaseName(h.moonIllum, h.moonWaxing);
  }

  // Planets — green 2+, olive 1, red 0 (informational; not in overall score)
  {
    const t = tileParts('tile-planets');
    const list = h.planets || [];
    setTileBand(t.root, list.length >= 2 ? 1 : list.length === 1 ? 0.5 : 0);
    t.value.textContent = list.length ? list.join(' ') : '—';
    t.value.classList.toggle('small', list.length >= 4);
    t.sub.textContent = 'above 5°';
  }

  // Light Pollution — measured automatically; tap shows details in Settings
  {
    const root = $('tile-bortle');
    root.className = `tile band-${band(scoreMetric('lightPollution', state.prefs.bortle))}`;
    root.querySelector('.t-value').textContent = String(state.prefs.bortle);
    root.querySelector('.t-sub').textContent = state.lightPollution ? 'Bortle · measured' : 'Bortle';
  }
}

/* ================= Night analysis =================
 * "The night of day D" = hours with the sun below the horizon between D's
 * noon and D+1's noon, so an evening window that crosses midnight reads as
 * one night instead of being chopped at 12:00 AM. */

export function nightHours(state, dayIdx) {
  const day = state.days[dayIdx];
  if (!day) return [];
  const next = state.days[dayIdx + 1];
  const noonMs = state.hours[day.hourIndices[0]].time + 12 * 3600000;
  const idxs = day.hourIndices.concat(next ? next.hourIndices : []);
  return nightHoursOf(idxs.map((i) => state.hours[i]), noonMs);
}

/* ================= Banner ================= */

export function renderBanner(state) {
  const h = getSelectedHour(state);
  if (!h) return;
  const tz = state.prefs.tz;
  const banner = $('banner');
  banner.className = `banner band-${band(h.score)}`;
  $('verdict').textContent = verdict(h.score);
  $('verdict-sub').textContent =
    `${fmtWeekdayLong(h.time, tz)} • ${fmtISODate(h.time, tz)} • ${fmtTime(h.time, tz)}`;
  $('verdict-meter-fill').style.width = `${Math.round(h.score * 100)}%`;
  const now = Date.now();
  const isLive = now >= h.time && now < h.time + 3600000;
  $('live-ribbon').classList.toggle('hidden', !isLive);
  $('btn-live').classList.toggle('live-now', isLive);

  // The hero sky reacts to the scrubbed hour: day, twilight, or deep night.
  document.body.classList.toggle('sky-day', h.sunAlt > 0);
  document.body.classList.toggle('sky-twilight', h.sunAlt <= 0 && h.sunAlt > -12);

  // Best stargazing window for the selected day's night — the single most
  // useful line for a glance on the way out the door.
  const bw = $('best-window');
  const bwText = $('best-window-text');
  const calBtn = $('cal-btn');
  const night = nightHours(state, state.selectedDay);
  const win = bestWindowFor(state);
  const label = state.days[state.selectedDay]?.isToday ? 'tonight' : 'that night';
  if (!night.length) {
    bwText.textContent = '✦ No dark hours';
  } else if (win) {
    const from = fmtTime(win.hours[0].time, tz);
    const to = fmtTime(win.hours[win.hours.length - 1].time + 3600000, tz);
    bwText.textContent = `✦ ${win.level === 'good' ? 'Best window' : 'Marginal window'} ${label}: ${from} – ${to}`;
  } else {
    bwText.textContent = `✦ No usable window ${label}`;
  }
  calBtn.classList.toggle('hidden', !win);
  bw.classList.remove('hidden');
}

/** The night's best contiguous window, for the banner pill + calendar export. */
export function bestWindowFor(state) {
  return bestWindowIn(nightHours(state, state.selectedDay));
}

/* ================= Update toast ================= */

export function showUpdateToast() {
  $('update-toast').classList.remove('hidden');
}

/* ================= Timeline ================= */

export function renderTimelineSegments(state) {
  const strip = $('timeline-strip');
  strip.querySelectorAll('.tl-tick').forEach((n) => n.remove());
  const day = state.days[state.selectedDay];
  if (!day) return;
  const playhead = $('playhead');
  strip.setAttribute('aria-valuemax', String(day.hourIndices.length * 60 - 1));
  const n = day.hourIndices.length;
  const at = (i) => `${(((i + 0.5) / n) * 100).toFixed(1)}%`;
  // Both gradients are anchored on CSS vars so night/color-blind modes
  // re-palette them without a light leak. The strip itself is the sun-
  // altitude sky (night black → twilight purple → day blue)…
  const sky = day.hourIndices.map((idx, i) => {
    const alt = state.hours[idx].sunAlt;
    const c = alt >= 0 ? 'var(--sky-dayc)' : alt > -18 ? 'var(--sky-twic)' : 'var(--sky-nightc)';
    return `${c} ${at(i)}`;
  });
  strip.style.background = `linear-gradient(90deg, ${sky.join(', ')})`;
  // …and the score bar below it is band-ACCURATE: the interpolated score is
  // sampled every 10 minutes through the same scoring path as the banner, so
  // the color under the playhead always agrees with the verdict. Boundaries
  // land where the score really crosses 0.66/0.33 (a green→red slide shows
  // yellow exactly as long as the score spends in the marginal band).
  const SAMPLES = 6; // per hour
  const bands = [];
  for (const idx of day.hourIndices) {
    for (let s = 0; s < SAMPLES; s++) {
      bands.push(band(scoredRecordAt(state, idx, (s * 60) / SAMPLES).score));
    }
  }
  const stops = [`var(--${bands[0]}) 0%`];
  for (let k = 1; k < bands.length; k++) {
    if (bands[k] !== bands[k - 1]) {
      const p = (k / bands.length) * 100;
      stops.push(`var(--${bands[k - 1]}) ${(p - 0.5).toFixed(1)}%`);
      stops.push(`var(--${bands[k]}) ${(p + 0.5).toFixed(1)}%`);
    }
  }
  stops.push(`var(--${bands[bands.length - 1]}) 100%`);
  $('score-strip').style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  // Tick labels on the 6-hour boundaries, located by LOCAL hour so DST days
  // (23/25 columns) label the right spots.
  const tz = state.prefs.tz;
  day.hourIndices.forEach((idx, i) => {
    const lh = localHour(state.hours[idx].time, tz);
    if (lh % 6 !== 0) return;
    const tick = document.createElement('span');
    tick.className = i === 0 ? 'tl-tick tl-tick-edge' : 'tl-tick';
    tick.textContent = lh === 0 ? '12AM' : lh === 12 ? '12PM' : lh < 12 ? `${lh}AM` : `${lh - 12}PM`;
    tick.style.left = `${((i / n) * 100).toFixed(2)}%`;
    strip.insertBefore(tick, playhead);
  });
  updatePlayhead(state);
}

export function updatePlayhead(state) {
  const day = state.days[state.selectedDay];
  if (!day || !day.hourIndices.length) return;
  const n = day.hourIndices.length;
  const pos = Math.min(state.selectedHour, n - 1);
  const minute = state.selectedMinute || 0;
  const playhead = $('playhead');
  // Exact position: a whole hour sits at its segment's left edge — centering
  // it would make the playhead jump backward when a drag crosses minute 0.
  playhead.style.left = `${((pos + minute / 60) / n) * 100}%`;
  playhead.classList.remove('hidden');
  const h = getSelectedHour(state);
  const label = fmtTime(h.time, state.prefs.tz);
  $('timeline-label').textContent = `▾ ${label}`;
  const strip = $('timeline-strip');
  strip.setAttribute('aria-valuenow', String(pos * 60 + minute));
  strip.setAttribute('aria-valuetext', label);
}

/* ================= Day tabs ================= */

export function renderDayTabs(state) {
  const wrap = $('day-tabs');
  const tz = state.prefs.tz;
  wrap.textContent = '';
  state.days.forEach((day, i) => {
    const btn = document.createElement('button');
    btn.className = `day-tab${i === state.selectedDay ? ' active' : ''}`;
    btn.dataset.day = String(i);
    btn.setAttribute('role', 'tab');
    const wd = document.createElement('span');
    wd.textContent = day.label;
    const num = document.createElement('span');
    num.className = 'dt-num';
    num.textContent = fmt(tz, { day: 'numeric' }).format(state.hours[day.hourIndices[0]].time);
    // Night-quality dot: the best hourly score of that day's night, so you
    // can pick the good night of the week at a glance.
    const night = nightHours(state, i);
    const bestScore = night.length ? Math.max(...night.map((h) => h.score)) : 0;
    const dot = document.createElement('i');
    dot.className = `dt-dot band-${band(bestScore)}`;
    btn.append(wd, num, dot);
    wrap.appendChild(btn);
  });
  // Keep the active tab in view (matters once you're days deep via swiping).
  const act = wrap.querySelector('.day-tab.active');
  if (act) wrap.scrollLeft = Math.max(0, act.offsetLeft - wrap.clientWidth / 2 + act.clientWidth / 2);
}

/* ================= Charts =================
 * Interactive inline SVG line charts. The SVG stretches horizontally
 * (preserveAspectRatio="none") but strokes use vector-effect:
 * non-scaling-stroke, and all text lives in HTML overlays so nothing
 * distorts. Height is a fixed 120px so vertical positions map 1:1.
 *
 * Features: multiple series per chart, daylight column shading, a "now"
 * marker, adaptive x-ticks (6-hour for short ranges, midnights for long),
 * and a touch/hover crosshair with a value tooltip. */

const CHART_W = 720;
const CHART_H = 120;

// Latest data per chart container, read by the shared pointer handler.
const chartData = {};

function buildChart(containerId, opts) {
  const el = $(containerId);
  const { times, series, min, max, tz, yFmt, dayRuns, nowIdx, vFmt } = opts;
  const n = times.length;
  if (n < 2) { el.textContent = ''; return; }
  // NOTE: colors must be concrete hex values, not var(--x) — CSS custom
  // properties don't resolve inside SVG presentation attributes.
  const range = max - min || 1;
  const X = (i) => (i / (n - 1)) * CHART_W;
  const Y = (v) => CHART_H - ((v - min) / range) * CHART_H;

  // Daylight column shading — a faint warm wash so night reads as the
  // stargazing-relevant part of the chart.
  let shading = '';
  for (const [i0, i1] of dayRuns || []) {
    const x0 = Math.max(0, X(i0) - CHART_W / (n - 1) / 2);
    const x1 = Math.min(CHART_W, X(i1 - 1) + CHART_W / (n - 1) / 2);
    shading += `<rect x="${x0.toFixed(1)}" y="0" width="${(x1 - x0).toFixed(1)}" height="${CHART_H}" fill="rgba(247,215,116,0.08)"/>`;
  }

  // Adaptive x-axis: 6-hour ticks for short ranges, midnights for long.
  const short = n <= 40;
  let vlines = '';
  let xlabs = '';
  for (let i = 0; i < n; i++) {
    const lh = localHour(times[i], tz);
    const isTick = short ? lh % 6 === 0 : lh === 0;
    if (!isTick) continue;
    const x = X(i);
    const major = lh === 0;
    vlines += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${CHART_H}" stroke="#26365f" stroke-dasharray="${major ? '3 4' : '2 5'}" vector-effect="non-scaling-stroke"/>`;
    const label = short
      ? (major ? fmtWeekdayShort(times[i], tz) : fmt(tz, { hour: 'numeric' }).format(times[i]))
      : fmtWeekdayShort(times[i], tz);
    xlabs += `<span class="xlab" style="left:${((x / CHART_W) * 100).toFixed(2)}%">${label}</span>`;
  }

  // 3 horizontal dashed gridlines at 25/50/75% with value labels
  const fmtY = yFmt || ((v) => String(Math.round(v)));
  let hlines = '';
  let ylabs = '';
  for (const f of [0.25, 0.5, 0.75]) {
    const y = CHART_H * (1 - f);
    hlines += `<line x1="0" y1="${y}" x2="${CHART_W}" y2="${y}" stroke="#26365f" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
    ylabs += `<span class="ylab" style="top:${y}px">${fmtY(min + range * f)}</span>`;
  }

  // "Now" marker (dashed accent line)
  let nowLine = '';
  if (nowIdx != null && nowIdx >= 0 && nowIdx < n) {
    const x = X(nowIdx);
    nowLine = `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${CHART_H}" stroke="#4f8fe8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.9" vector-effect="non-scaling-stroke"/>`;
  }

  // Series: optional gradient area fill on the flagged series, then a glow
  // under-stroke and the main line for each.
  let defs = '';
  let body = '';
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    if (s.fill) {
      const gid = `grad-${containerId}-${si}`;
      defs +=
        `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${s.color}" stop-opacity="0.30"/>` +
        `<stop offset="1" stop-color="${s.color}" stop-opacity="0.02"/>` +
        `</linearGradient>`;
      const areaD = `M 0 ${CHART_H} L ${pts.split(' ').map((p) => p.replace(',', ' ')).join(' L ')} L ${CHART_W} ${CHART_H} Z`;
      body += `<path d="${areaD}" fill="url(#${gid})" stroke="none"/>`;
    }
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
    body +=
      `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-opacity="0.20" stroke-width="6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
      `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round"${dash} vector-effect="non-scaling-stroke"/>`;
  });

  el.innerHTML =
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>${defs}</defs>` + shading + hlines + vlines + nowLine + body +
    `</svg>` +
    `<div class="ch-cursor"></div><div class="ch-tip"></div>` +
    ylabs + xlabs;

  chartData[containerId] = { times, series, tz, vFmt };
  attachChartPointer(el);
}

function attachChartPointer(el) {
  if (el.dataset.pointerWired) return;
  el.dataset.pointerWired = '1';

  const show = (e) => {
    const st = chartData[el.id];
    const svg = el.querySelector('svg');
    if (!st || !svg) return;
    const rect = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(frac * (st.times.length - 1));
    const xPct = (idx / (st.times.length - 1)) * 100;

    const cursor = el.querySelector('.ch-cursor');
    cursor.style.display = 'block';
    cursor.style.left = `${xPct}%`;

    const tip = el.querySelector('.ch-tip');
    const when = `${fmtWeekdayShort(st.times[idx], st.tz)} ${fmtTime(st.times[idx], st.tz)}`;
    tip.innerHTML =
      `<div class="tt">${when}</div>` +
      st.series.map((s) =>
        `<div class="tv"><i style="background:${s.color}"></i>${s.label ? s.label + ' ' : ''}${st.vFmt(s.values[idx])}</div>`
      ).join('');
    tip.style.display = 'block';
    // Flip the tooltip to the other side of the cursor near the edges.
    if (xPct > 55) {
      tip.style.left = 'auto';
      tip.style.right = `${100 - xPct + 2}%`;
    } else {
      tip.style.right = 'auto';
      tip.style.left = `${xPct + 2}%`;
    }
  };
  const hide = () => {
    const c = el.querySelector('.ch-cursor');
    const t = el.querySelector('.ch-tip');
    if (c) c.style.display = 'none';
    if (t) t.style.display = 'none';
  };

  el.addEventListener('pointermove', show);
  el.addEventListener('pointerdown', show);
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointercancel', hide);
}

/** Contiguous [start, end) index runs where pred(hour) holds. */
function runsWhere(slice, pred) {
  const out = [];
  let start = -1;
  slice.forEach((h, i) => {
    if (pred(h)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, slice.length]);
  return out;
}

function setLegend(id, entries) {
  $(id).innerHTML = entries
    .map((e) => `<span><i style="background:${e.color}"></i>${e.label}</span>`)
    .join('');
}

export function renderCharts(state) {
  if (!state.hours.length) return;
  const tz = state.prefs.tz;
  const metric = state.prefs.units === 'metric';
  const rangeH = state.chartRange || 72;
  const lookback = 6; // a little past context so the "now" line has meaning
  const start = Math.max(0, state.currentHourIndex - lookback);
  const slice = state.hours.slice(start, start + rangeH + lookback);
  if (slice.length < 2) return;
  const times = slice.map((h) => h.time);
  const dayRuns = runsWhere(slice, (h) => h.isDay === 1);
  const nowIdx = state.currentHourIndex - start;
  const deg = `°${metric ? 'C' : 'F'}`;
  const windU = metric ? 'km/h' : 'mph';

  $('chart-temp-title').childNodes[0].textContent = `Temperature (${deg})`;
  $('chart-wind-title').childNodes[0].textContent = `Wind (${windU})`;

  // Brightened variants of the palette hues — the raw tile colors are tuned
  // for large surfaces and read muddy as 2px strokes on navy.
  buildChart('chart-cloud', {
    times, tz, dayRuns, nowIdx, min: 0, max: 100,
    series: [
      { values: slice.map((h) => h.cloud), color: '#c76a6a', label: 'Total', fill: true },
      { values: slice.map((h) => h.cloudHigh), color: '#d9a05e', label: 'High', dash: '4 4' },
    ],
    vFmt: (v) => `${Math.round(v)}%`,
  });
  setLegend('chart-cloud-legend', [
    { color: '#c76a6a', label: 'Total' }, { color: '#d9a05e', label: 'High' },
  ]);

  const temps = slice.map((h) => h.temp);
  const dews = slice.map((h) => h.dewPoint);
  buildChart('chart-temp', {
    times, tz, dayRuns, nowIdx,
    min: Math.min(...temps, ...dews) - 4,
    max: Math.max(...temps, ...dews) + 4,
    series: [
      { values: temps, color: '#5f9bef', label: 'Temp', fill: true },
      { values: dews, color: '#8fa8d8', label: 'Dew', dash: '4 4' },
    ],
    vFmt: (v) => `${Math.round(v)}${deg}`,
  });
  setLegend('chart-temp-legend', [
    { color: '#5f9bef', label: 'Temp' }, { color: '#8fa8d8', label: 'Dew point' },
  ]);

  const winds = slice.map((h) => h.wind);
  buildChart('chart-wind', {
    times, tz, dayRuns, nowIdx, min: 0, max: Math.max(...winds) + 5,
    series: [{ values: winds, color: '#5aa35c', label: '', fill: true }],
    vFmt: (v) => `${Math.round(v)} ${windU}`,
  });
  setLegend('chart-wind-legend', []);

  buildChart('chart-astro', {
    times, tz, dayRuns, nowIdx, min: 0, max: 1,
    yFmt: (v) => v.toFixed(1),
    series: [
      { values: slice.map((h) => h.seeing), color: '#d8b25a', label: 'Seeing' },
      { values: slice.map((h) => h.transparency), color: '#6fc3c9', label: 'Transp', dash: '4 4' },
    ],
    vFmt: (v) => v.toFixed(1),
  });
  setLegend('chart-astro-legend', [
    { color: '#d8b25a', label: 'Seeing' }, { color: '#6fc3c9', label: 'Transparency' },
  ]);
}

/* ================= Forecast grid (Clear Outside-style) =================
 * One block per day: rows are metrics, columns are hours, every cell
 * colored by the same scoring bands as the tiles. Built as an HTML string
 * per day (thousands of cells — string assembly is much faster than DOM
 * calls, and every value is internally generated). */

export function renderForecast(state) {
  const wrap = $('forecast-days');
  if (!state.days.length) { wrap.textContent = ''; return; }
  const tz = state.prefs.tz;
  const metric = state.prefs.units === 'metric';
  const spreadToF = metric ? 1.8 : 1; // dew-spread thresholds are in °F

  const bandOf = (score) => `band-${band(score)}`;
  const humBand = (rh) => (rh <= 70 ? 'band-good' : rh <= 85 ? 'band-marginal' : 'band-bad');
  const dewBand = (h) => {
    const spreadF = (h.temp - h.dewPoint) * spreadToF; // small spread → fog risk
    return spreadF >= 5 ? 'band-good' : spreadF >= 2.5 ? 'band-marginal' : 'band-bad';
  };

  const rows = [
    { label: 'Sky', cell: (h) => [bandOf(h.score), ''] },
    { label: 'Cloud %', cell: (h) => [bandOf(scoreMetric('cloud', h.cloud)), Math.round(h.cloud)] },
    { label: 'Low %', cell: (h) => [bandOf(scoreMetric('cloud', h.cloudLow)), Math.round(h.cloudLow)] },
    { label: 'Mid %', cell: (h) => [bandOf(scoreMetric('cloud', h.cloudMid)), Math.round(h.cloudMid)] },
    { label: 'High %', cell: (h) => [bandOf(scoreMetric('cloud', h.cloudHigh)), Math.round(h.cloudHigh)] },
    { label: 'Precip %', cell: (h) => [bandOf(scoreMetric('precip', h.precipProb)), Math.round(h.precipProb)] },
    { label: metric ? 'Wind km/h' : 'Wind mph', cell: (h) => [bandOf(scoreMetric('wind', h.windMph)), Math.round(h.wind)] },
    { label: 'Temp °', cell: (h) => [bandOf(scoreMetric('windChill', h.apparentF)), Math.round(h.temp)] },
    { label: 'Dew °', cell: (h) => [dewBand(h), Math.round(h.dewPoint)] },
    { label: 'Humidity %', cell: (h) => [humBand(h.humidity), Math.round(h.humidity)] },
    { label: 'Seeing', cell: (h) => [bandOf(scoreMetric('seeing', h.seeing)), h.seeing.toFixed(1)] },
    { label: 'Transp.', cell: (h) => [bandOf(scoreMetric('transparency', h.transparency)), h.transparency.toFixed(1)] },
    {
      label: 'Moon',
      cell: (h) => [
        bandOf(scoreMetric('moon', null, { moonAltitude: h.moonAlt, moonIllum: h.moonIllum })),
        h.moonAlt >= 0 ? '●' : '',
      ],
    },
  ];

  let html = '';
  for (const [di, day] of state.days.slice(0, state.forecastDays || 7).entries()) {
    const hours = day.hourIndices.map((i) => state.hours[i]);
    const first = hours[0];

    const sunPart = `☀ ↑${day.sunrise != null ? fmtTime(day.sunrise, tz) : '—'} ↓${day.sunset != null ? fmtTime(day.sunset, tz) : '—'}`;
    const moonPart = `🌙 ↑${day.moonRise != null ? fmtTime(day.moonRise, tz) : '—'} ↓${day.moonSet != null ? fmtTime(day.moonSet, tz) : '—'} · ${Math.round(first.moonIllum * 100)}%`;
    let darkPart;
    if (day.neverDark) {
      darkPart = 'No astro darkness';
    } else {
      const bits = [];
      if (day.darkEnd != null) bits.push(`until ${fmtTime(day.darkEnd, tz)}`);
      if (day.darkStart != null) bits.push(`from ${fmtTime(day.darkStart, tz)}`);
      darkPart = bits.length ? `✦ Dark ${bits.join(' · ')}` : '✦ Dark all day';
    }

    let head = `<tr class="fc-hours"><th></th>`;
    hours.forEach((h, i) => {
      const now = day.hourIndices[i] === state.currentHourIndex;
      head += `<td${now ? ' class="fc-nowhdr"' : ''}>${localHour(h.time, tz)}</td>`;
    });
    head += '</tr>';

    let bodyRows = '';
    for (const row of rows) {
      bodyRows += `<tr><th>${row.label}</th>`;
      hours.forEach((h, i) => {
        const [cls, txt] = row.cell(h);
        const now = day.hourIndices[i] === state.currentHourIndex ? ' fc-now' : '';
        bodyRows += `<td class="${cls}${now}">${txt}</td>`;
      });
      bodyRows += '</tr>';
    }

    html +=
      `<div class="panel fc-day" data-day="${di}">` +
      `<div class="fc-head">` +
      `<div class="fc-title">${day.label === 'Today' ? 'Today' : fmtWeekdayLong(first.time, tz)} · ${fmtISODate(first.time, tz)}</div>` +
      `<div class="fc-meta"><span>${sunPart}</span><span>${moonPart}</span><span>${darkPart}</span></div>` +
      `</div>` +
      `<div class="fc-scroll"><table class="fc-grid">${head}${bodyRows}</table></div>` +
      `</div>`;
  }
  wrap.innerHTML = html;

  // Scroll today's grid so the current-hour column is in view.
  const nowHdr = wrap.querySelector('.fc-nowhdr');
  if (nowHdr) {
    const scroller = nowHdr.closest('.fc-scroll');
    scroller.scrollLeft = Math.max(0, nowHdr.offsetLeft - scroller.clientWidth / 2);
  }
}

/* ================= Settings ================= */

export function renderSettings(state) {
  $('loc-name').textContent = state.prefs.name || '—';
  $('loc-coords').textContent =
    Number.isFinite(state.prefs.lat)
      ? `${state.prefs.lat.toFixed(4)}, ${state.prefs.lon.toFixed(4)}`
      : '—';

  const cap = $('bortle-caption');
  const lp = state.lightPollution;
  cap.textContent = lp
    ? `Bortle ${lp.bortle} — measured for this location · ${lp.mpsas.toFixed(2)} mag/arcsec² (World Atlas 2024). Set automatically; it updates when your location changes.`
    : `Measured automatically from the World Atlas 2024 for your location. Currently using Bortle ${state.prefs.bortle}.`;

  document.querySelectorAll('#card-units .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.units === state.prefs.units);
  });
}

export function renderSearchResults(results, query) {
  const ul = $('search-results');
  ul.textContent = '';
  if (results === null) return; // cleared
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `No places found for “${query}”`;
    ul.appendChild(li);
    return;
  }
  for (const r of results) {
    const li = document.createElement('li');
    li.dataset.lat = String(r.lat);
    li.dataset.lon = String(r.lon);
    li.dataset.name = r.name;
    const region = [r.admin1, r.country].filter(Boolean).join(', ');
    li.textContent = r.name;
    if (region) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = region;
      li.appendChild(sub);
    }
    ul.appendChild(li);
  }
}

/* ================= Tonight's sky panel ================= */

function fmtMonthDay(ms, tz) {
  return fmt(tz, { month: 'short', day: 'numeric' }).format(ms);
}

export function renderTonight(state) {
  const body = $('tonight-body');
  if (!state.days.length) { body.textContent = ''; return; }
  const tz = state.prefs.tz;
  const { lat } = state.prefs;
  const day = state.days[state.selectedDay];
  const firstTime = state.hours[day.hourIndices[0]].time;
  $('tonight-title').textContent = day.isToday
    ? "Tonight's sky"
    : `Night of ${fmtMonthDay(firstTime, tz)}`;

  const rows = []; // { ic, text, cls? }
  const night = nightHours(state, state.selectedDay);

  // Moon phase + upcoming lunations
  const midnightish = night[Math.floor(night.length / 2)] || state.hours[day.hourIndices[0]];
  rows.push({
    ic: '🌙',
    text: `${phaseName(midnightish.moonIllum, midnightish.moonWaxing)} · ${Math.round(midnightish.moonIllum * 100)}% lit`,
  });
  if (state.lunations && state.lunations.length) {
    const nextNew = state.lunations.find((l) => l.type === 'new');
    const nextFull = state.lunations.find((l) => l.type === 'full');
    const bits = [];
    if (nextNew) bits.push(`New moon ${fmtMonthDay(nextNew.time, tz)}`);
    if (nextFull) bits.push(`full ${fmtMonthDay(nextFull.time, tz)}`);
    rows.push({ ic: '🌑', text: bits.join(' · ') });
  }

  // Milky Way core
  if (night.length) {
    const mw = milkyWayPeak(night.map((h) => h.time), lat, state.prefs.lon);
    if (mw && mw.alt >= 20) {
      rows.push({ ic: '✨', text: `Milky Way core up to ${Math.round(mw.alt)}° around ${fmtTime(mw.time, tz)}`, cls: 'tn-good' });
    } else if (mw && mw.alt >= 8) {
      rows.push({ ic: '✨', text: `Milky Way core stays low (${Math.round(mw.alt)}° around ${fmtTime(mw.time, tz)})` });
    } else {
      rows.push({ ic: '✨', text: 'Milky Way core not visible this night' });
    }
  }

  // Planets: rise time + peak altitude across the night, best three
  if (night.length) {
    const startMs = night[0].time;
    const endMs = night[night.length - 1].time + 3600000;
    const planets = planetNightEvents(startMs, endMs, lat, state.prefs.lon).slice(0, 3);
    for (const p of planets) {
      const risePart = p.rise ? `↑ ${fmtTime(p.rise, tz)}` : 'up at dusk';
      rows.push({
        ic: '🪐',
        text: `${p.name} ${risePart} · peaks ${Math.round(p.peakAlt)}° at ${fmtTime(p.peakTime, tz)}`,
        cls: p.peakAlt >= 30 ? 'tn-good' : '',
      });
    }
  }

  // Active meteor showers (top two by ZHR)
  const iso = fmtISODate(firstTime, tz);
  const showers = activeShowers(Number(iso.slice(5, 7)), Number(iso.slice(8, 10))).slice(0, 2);
  for (const s of showers) {
    const peakDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
      .format(Date.UTC(2024, s.peak[0] - 1, s.peak[1])); // year irrelevant for a month-day label
    const moonNote = midnightish.moonIllum > 0.6 ? ' · moonlight interferes' : '';
    rows.push({
      ic: '☄️',
      text: s.atPeak
        ? `${s.name} peaking now — up to ${s.zhr}/hr${moonNote}`
        : `${s.name} active (ZHR ${s.zhr}, peak ${peakDate})${moonNote}`,
      cls: s.atPeak ? 'tn-good' : '',
    });
  }

  // Dew on optics — the telescope-owner's silent enemy
  {
    const metric = state.prefs.units === 'metric';
    const risk = dewRiskStart(night, metric ? 1.8 : 1);
    if (risk) {
      rows.push({
        ic: '💧',
        text: `${risk.heavy ? 'Heavy dew likely' : 'Dew possible'} on optics from ${fmtTime(risk.time, tz)}`,
        cls: risk.heavy ? 'tn-warn' : '',
      });
    }
  }

  // Aurora outlook (only when meaningful for the latitude)
  if (state.kp) {
    const needed = kpNeeded(lat);
    if (state.kp.maxKp >= needed) {
      rows.push({ ic: '🌌', text: `Aurora possible — Kp ${state.kp.maxKp.toFixed(1)} forecast`, cls: 'tn-good' });
    } else if (Math.abs(lat) >= 48) {
      rows.push({ ic: '🌌', text: `Aurora unlikely (Kp ${state.kp.maxKp.toFixed(1)}, needs ${needed}+)` });
    }
  }

  // Forecast-model agreement over the night's cloud cover
  const spreads = night.map((h) => h.cloudSpread).filter((v) => v != null);
  if (spreads.length) {
    const avg = Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length);
    if (avg >= 25) {
      rows.push({ ic: '⚠️', text: `Cloud models disagree by ±${avg}% — low confidence`, cls: 'tn-warn' });
    } else {
      rows.push({ ic: '✔︎', text: `Cloud models agree (±${avg}%)` });
    }
  }

  body.textContent = '';
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = `tn-row${r.cls ? ' ' + r.cls : ''}`;
    const ic = document.createElement('span');
    ic.className = 'tn-ic';
    ic.textContent = r.ic;
    const tx = document.createElement('span');
    tx.textContent = r.text;
    div.append(ic, tx);
    body.appendChild(div);
  }
}

/* ================= Spot comparison ================= */

export function renderSpotCompare(state) {
  const panel = $('spots-panel');
  const body = $('spots-body');
  if (!state.spotCompare) {
    panel.classList.add('hidden');
    return;
  }
  body.textContent = '';
  for (const spot of state.spotCompare) {
    const row = document.createElement('div');
    row.className = 'sp-row';
    const dot = document.createElement('i');
    dot.className = `sp-dot band-${band(scoreMetric('cloud', spot.cloud))}`;
    const name = document.createElement('span');
    name.className = 'sp-name';
    name.textContent = spot.name;
    const val = document.createElement('span');
    val.className = 'sp-val';
    val.textContent = `${Math.round(spot.cloud)}% cloud`;
    row.append(dot, name, val);
    body.appendChild(row);
  }
  panel.classList.remove('hidden');
}

/* ================= Score breakdown ================= */

const METRIC_INFO = [
  { key: 'cloud', label: 'Cloud cover' },
  { key: 'darkness', label: 'Darkness' },
  { key: 'precip', label: 'Precipitation' },
  { key: 'moon', label: 'Moon' },
  { key: 'transparency', label: 'Transparency' },
  { key: 'seeing', label: 'Seeing' },
  { key: 'wind', label: 'Wind' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'lightPollution', label: 'Light pollution' },
  { key: 'windChill', label: 'Comfort' },
];

export function renderBreakdown(state) {
  const h = getSelectedHour(state);
  const body = $('breakdown-body');
  if (!h) { body.textContent = ''; return; }
  const ctx = {
    bortle: state.prefs.bortle,
    moonAltitude: h.moonAlt,
    sunAltitude: h.sunAlt,
    moonIllum: h.moonIllum,
  };
  const valueOf = {
    cloud: h.cloud, precip: h.precipProb, wind: h.windMph, visibility: h.visMiles,
    seeing: h.seeing, transparency: h.transparency, lightPollution: ctx.bortle,
    windChill: h.apparentF, darkness: null, moon: null,
  };

  body.textContent = '';
  for (const m of METRIC_INFO) {
    const score = scoreMetric(m.key, valueOf[m.key], ctx);
    const weight = WEIGHTS[m.key];
    const row = document.createElement('div');
    row.className = 'bd-row';
    const label = document.createElement('span');
    label.className = 'bd-label';
    label.textContent = m.label;
    const track = document.createElement('div');
    track.className = 'bd-track';
    // Track width encodes the metric's weight; fill encodes its score.
    track.style.width = `${Math.round(weight / 0.30 * 100)}px`;
    const fill = document.createElement('i');
    fill.className = `bd-fill band-${band(score)}`;
    fill.style.width = `${Math.round(score * 100)}%`;
    track.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'bd-val';
    val.textContent = `${(score * weight).toFixed(2)} / ${weight.toFixed(2)}`;
    row.append(label, track, val);
    body.appendChild(row);
  }

  const caps = [];
  if (h.sunAlt > 0) caps.push('daylight caps the score at 0.25');
  if (h.cloud >= 90) caps.push('≥90% cloud caps it at 0.20');
  if (h.precipProb >= 70) caps.push('≥70% precip caps it at 0.25');
  if (caps.length) {
    const note = document.createElement('p');
    note.className = 'bd-note dim';
    note.textContent = `Hard override: ${caps.join('; ')}.`;
    body.appendChild(note);
  }
}

export function toggleBreakdown(state) {
  const el = $('breakdown');
  const opening = el.classList.contains('hidden');
  el.classList.toggle('hidden');
  if (opening) renderBreakdown(state);
}

export function isBreakdownOpen() {
  return !$('breakdown').classList.contains('hidden');
}

/* ================= Data age / offline ================= */

export function renderDataAge(state) {
  const el = $('data-age');
  if (!state.lastFetch) { el.textContent = ''; return; }
  const tz = state.prefs.tz;
  const ageMs = Date.now() - state.lastFetch;
  const stale = state.offlineData || ageMs > 2 * 3600000;
  el.textContent = `${state.offlineData ? '⚠ offline · ' : ''}Updated ${fmtTime(state.lastFetch, tz)}`;
  el.classList.toggle('stale', stale);
}

/* ================= Saved locations ================= */

export function renderSavedLocations(state) {
  const ul = $('saved-locs');
  ul.textContent = '';
  const saved = state.prefs.saved || [];
  for (const [i, loc] of saved.entries()) {
    const li = document.createElement('li');
    li.dataset.idx = String(i);
    const isCurrent =
      Math.abs(loc.lat - state.prefs.lat) < 0.005 && Math.abs(loc.lon - state.prefs.lon) < 0.005;
    li.className = isCurrent ? 'current' : '';
    const name = document.createElement('span');
    name.textContent = `${isCurrent ? '● ' : ''}${loc.name}`;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`;
    const ren = document.createElement('button');
    ren.className = 'loc-del loc-ren';
    ren.dataset.rename = String(i);
    ren.setAttribute('aria-label', `Rename ${loc.name}`);
    ren.textContent = '✎';
    const del = document.createElement('button');
    del.className = 'loc-del';
    del.dataset.del = String(i);
    del.setAttribute('aria-label', `Remove ${loc.name}`);
    del.textContent = '×';
    li.append(name, sub, ren, del);
    ul.appendChild(li);
  }
}

/* ================= Appearance ================= */

export function applyAppearance(state) {
  document.body.classList.toggle('night', !!state.prefs.night);
  document.body.classList.toggle('cb', !!state.prefs.cb);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.prefs.night ? '#170404' : '#17264d';
  const nightBtn = $('night-btn');
  nightBtn.setAttribute('aria-pressed', String(!!state.prefs.night));
  const tn = $('toggle-night');
  const tc = $('toggle-cb');
  tn.classList.toggle('on', !!state.prefs.night);
  tn.setAttribute('aria-checked', String(!!state.prefs.night));
  tc.classList.toggle('on', !!state.prefs.cb);
  tc.setAttribute('aria-checked', String(!!state.prefs.cb));
}

/* ================= Sky map ================= */
// Canvas colors are hardcoded hex/rgb on purpose (canvas can't read CSS vars —
// same rule as the SVG charts). Night mode reddens the whole canvas via the
// body.night filter, so no red-mode handling is needed here.

const SKY_FONT = '500 10px -apple-system, "Segoe UI", Roboto, sans-serif';
const SKY_FONT_LG = '600 12px -apple-system, "Segoe UI", Roboto, sans-serif';
const SKY_FONT_CONST = '500 10px -apple-system, "Segoe UI", Roboto, sans-serif';

// Planets are far too small to render at true angular size, so each gets a
// hand-set disc radius that reflects how bright it actually looks by eye.
const PLANET_STYLE = {
  Me: { color: '#c9b294', r: 2.4 },
  V: { color: '#fdf4d6', r: 4.4 },
  Ma: { color: '#e5764c', r: 3.0 },
  J: { color: '#e8d6b0', r: 4.1 },
  S: { color: '#e3cd8c', r: 3.3 },
};

/* ---------------------------- sky colour ---------------------------- */

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
const rgb = (c, a = 1) => (a >= 1
  ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
  : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// Zenith/horizon pairs for four lighting regimes, interpolated by sun altitude.
const SKY_STOPS = [
  { sun: -18, zenith: [4, 7, 14], horizon: [11, 17, 32] },   // astronomical dark
  { sun: -6, zenith: [10, 18, 46], horizon: [42, 50, 86] },  // nautical twilight
  { sun: 0, zenith: [34, 62, 112], horizon: [124, 116, 124] }, // sunrise/sunset
  { sun: 8, zenith: [45, 92, 152], horizon: [150, 180, 212] }, // full day
];

function skyPalette(sunAlt) {
  if (sunAlt <= SKY_STOPS[0].sun) return SKY_STOPS[0];
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const a = SKY_STOPS[i - 1];
    const b = SKY_STOPS[i];
    if (sunAlt <= b.sun) {
      const t = (sunAlt - a.sun) / (b.sun - a.sun);
      return { zenith: mix(a.zenith, b.zenith, t), horizon: mix(a.horizon, b.horizon, t) };
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1];
}

/**
 * Sky colour at a given altitude. The horizon term is what sells it: real sky
 * brightens toward the horizon, and under a light-polluted sky it goes warm.
 * Bortle comes straight from the app's own measured light-pollution value, so
 * a city sky renders orange near the horizon and a dark site does not.
 */
function skyRgbAt(alt, sunAlt, bortle) {
  const p = skyPalette(sunAlt);
  const hf = clamp01(1 - Math.max(0, alt) / 50); // 1 at the horizon → 0 by 50°
  const base = mix(p.zenith, p.horizon, hf * hf * (3 - 2 * hf)); // smoothstep
  // Sky glow only shows once the sun is down; by day it is invisible anyway.
  const lp = clamp01((bortle - 2) / 7) * clamp01(-sunAlt / 8);
  const glow = hf * hf * hf * lp;
  return [base[0] + 52 * glow, base[1] + 32 * glow, base[2] + 10 * glow];
}

/* ------------------------- bright-star glow ------------------------- */

// Halos are pre-rendered sprites rather than per-star radial gradients: a
// CanvasGradient is bound to its coordinates, so it cannot be reused across
// positions, but an offscreen canvas can be blitted anywhere.
const glowCache = new Map();
const GLOW_CACHE_MAX = 320;

function glowSprite(color, r) {
  const key = `${color}|${r}`;
  const hit = glowCache.get(key);
  if (hit) return hit;
  if (glowCache.size > GLOW_CACHE_MAX) glowCache.clear();
  const size = Math.ceil(r * 2) + 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const mid = size / 2;
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, r);
  grad.addColorStop(0, toRgba(color, 0.85));
  grad.addColorStop(0.28, toRgba(color, 0.28));
  grad.addColorStop(1, toRgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowCache.set(key, c);
  return c;
}

function drawGlow(ctx, x, y, r, color, alpha) {
  const sprite = glowSprite(color, Math.max(2, Math.round(r)));
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - sprite.width / 2, y - sprite.height / 2);
  ctx.globalAlpha = 1;
}

/** Subtle 4-ray flare, reserved for the handful of genuinely dazzling objects. */
function drawFlare(ctx, x, y, len, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x - len, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x, y - len); ctx.lineTo(x, y + len);
  ctx.stroke();
  ctx.restore();
}

/* ----------------------------- the moon ----------------------------- */

/**
 * Moon disc with a real terminator. The lit region is the half-limb facing the
 * sun closed by an ellipse whose semi-minor axis is r·(1−2k) — that single
 * expression gives a crescent, a straight-edged half moon at k = 0.5, and a
 * full disc at k = 1, with the sign flip handling waxing versus waning.
 */
function drawMoon(ctx, x, y, r, fraction, limbAngle) {
  drawGlow(ctx, x, y, r * 3.2, 'rgb(226,232,244)', 0.5);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(limbAngle);
  // Earthshine: the unlit disc stays faintly visible, as it does in life.
  ctx.fillStyle = 'rgba(120,132,156,0.42)';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  const k = clamp01(fraction);
  const term = r * (1 - 2 * k);
  ctx.fillStyle = '#eef1f7';
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false); // limb facing the sun
  ctx.ellipse(0, 0, Math.abs(term), r, 0, Math.PI / 2, -Math.PI / 2, term > 0);
  ctx.fill();

  ctx.strokeStyle = 'rgba(210,218,232,0.5)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------ picking ------------------------------ */

// Last frame's hit-testable objects, in screen coordinates. Rebuilt every
// render so a tap always tests against exactly what the user can see.
let skyPickList = [];
let skyPickRoll = 0;
let skyPickSize = { w: 0, h: 0 };

/**
 * Hit-test a client-space point against the last rendered frame. The canvas is
 * counter-rotated by the AR roll, so the tap has to be rotated into that same
 * frame before it can be compared with the stored positions.
 */
export function pickSky(clientX, clientY) {
  const canvas = $('sky-canvas');
  if (!canvas || !skyPickList.length) return null;
  const box = canvas.getBoundingClientRect();
  let x = clientX - box.left;
  let y = clientY - box.top;
  if (skyPickRoll) {
    const cx = skyPickSize.w / 2;
    const cy = skyPickSize.h / 2;
    const a = -skyPickRoll * Math.PI / 180; // same sign as the render transform
    const dx = x - cx;
    const dy = y - cy;
    x = cx + dx * Math.cos(-a) - dy * Math.sin(-a);
    y = cy + dx * Math.sin(-a) + dy * Math.cos(-a);
  }
  return pickNearest(skyPickList, x, y, 26);
}

/**
 * Canvas-space rectangles covered by the floating DOM chrome (tool buttons,
 * info card, status text). Labels drawn under these are simply invisible, so
 * they are fed to the label placer as pre-occupied space.
 */
function chromeBlockers(canvas, state, roll = 0) {
  const box = canvas.getBoundingClientRect();
  const out = [];
  // Labels are drawn inside the roll-rotated context, so a screen-space rect
  // has to be rotated into that frame before it can block anything. The AABB
  // of the rotated rect over-blocks slightly, which is the safe direction.
  const a = roll * Math.PI / 180;
  const cx = box.width / 2;
  const cy = box.height / 2;
  const add = (el) => {
    if (!el || el.classList.contains('hidden')) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x0 = r.left - box.left;
    const y0 = r.top - box.top;
    if (!roll) {
      out.push({ x: x0, y: y0, w: r.width, h: r.height });
      return;
    }
    const xs = [];
    const ys = [];
    for (const [px, py] of [[x0, y0], [x0 + r.width, y0], [x0, y0 + r.height], [x0 + r.width, y0 + r.height]]) {
      const dx = px - cx;
      const dy = py - cy;
      xs.push(cx + dx * Math.cos(a) - dy * Math.sin(a));
      ys.push(cy + dx * Math.sin(a) + dy * Math.cos(a));
    }
    out.push({
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    });
  };
  add(canvas.parentElement && canvas.parentElement.querySelector('.sky-tools'));
  if (state.skySelected) add($('sky-info'));
  return out;
}

/* ------------------------------ render ------------------------------ */

export function renderSky(state) {
  const canvas = $('sky-canvas');
  if (!canvas) return;
  const { lat, lon } = state.prefs;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const hour = getSelectedHour(state);
  const when = hour ? new Date(hour.time) : new Date();
  const view = state.sky;
  const jd = julianDate(when);
  const fc = frameContext(jd, lat, lon);
  const sunAlt = hour ? hour.sunAlt : sunAltitude(when, lat, lon);
  const bortle = Number(state.prefs.bortle) || 5;
  const camera = !!(state.ar && state.ar.camera);
  const f = focalLength(view, w);

  const roll = state.ar && state.ar.active && Number.isFinite(state.sky.roll) ? state.sky.roll : 0;
  ctx.save();
  if (roll) {
    ctx.translate(w / 2, h / 2);
    // Counter-rotate: the phone rolling clockwise makes the world appear
    // counter-clockwise through the screen. Sign field-verified 2026-08-03
    // (positive roll here made the horizon follow the phone).
    ctx.rotate(-roll * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  // A rolled canvas can reveal anything inside the viewport's circumscribed
  // circle — widen the star cull to cover it, else corners pop in under roll.
  const cullMargin = roll ? (Math.hypot(w, h) - Math.min(w, h)) / 2 + 10 : 10;
  // Everything is drawn into this over-sized rect so a rolled canvas has no
  // bare corners.
  const OVER = [-w, -h, 3 * w, 3 * h];

  const yHor = horizonY(view, w, h);
  const groundVisible = yHor !== null && yHor < 2 * h;

  /* --- 1. background: sky gradient, sun glow, ground --- */
  if (camera) {
    ctx.clearRect(...OVER);
    ctx.fillStyle = 'rgba(2, 4, 10, 0.32)';
    ctx.fillRect(...OVER);
  } else {
    // Sample the gradient by un-projecting screen rows back to real altitudes,
    // so the colour ramp follows the sky rather than the canvas box — it stays
    // correct at any zoom or view altitude.
    const top = -h;
    const bot = 2 * h;
    const grad = ctx.createLinearGradient(0, top, 0, bot);
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const { alt } = unproject(w / 2, top + (bot - top) * t, view, w, h);
      grad.addColorStop(t, rgb(skyRgbAt(alt, sunAlt, bortle)));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(...OVER);

    // Directional twilight: a warm bloom centred on the sun, above or just
    // below the horizon. This is what makes the sky look like it has a west.
    if (sunAlt > -14) {
      const sun = skyBodies(when, lat, lon).find((b) => b.kind === 'sun');
      const sp = sun && project(sun.az, Math.max(sun.alt, -6), view, w, h);
      if (sp) {
        const strength = clamp01((sunAlt + 14) / 16) * (sunAlt > 2 ? 0.45 : 1);
        const R = Math.max(w, h) * 1.1;
        const bloom = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, R);
        bloom.addColorStop(0, `rgba(255,196,120,${0.42 * strength})`);
        bloom.addColorStop(0.35, `rgba(226,140,96,${0.16 * strength})`);
        bloom.addColorStop(1, 'rgba(180,110,90,0)');
        ctx.fillStyle = bloom;
        ctx.fillRect(...OVER);
      }
    }
  }

  /* --- 2. Milky Way (night only, under everything else) --- */
  if (state.skyData && state.skyData.mw && sunAlt < -8 && !camera) {
    // Brightness tracks the measured sky quality — but never to zero. Under a
    // Bortle 8 sky you genuinely cannot see the Milky Way, yet the whole point
    // of drawing it here is to show WHERE it is, so a city sky keeps a faint
    // trace rather than nothing at all.
    const visibility = (0.42 + 0.58 * clamp01((7.5 - bortle) / 5)) * clamp01((-sunAlt - 8) / 6);
    if (visibility > 0.02) {
      ctx.save();
      if (typeof ctx.filter === 'string') ctx.filter = 'blur(7px)';
      ctx.fillStyle = `rgba(196,206,236,${0.055 * visibility})`;
      for (const level of state.skyData.mw) {
        const polys = polygonDrawList(level, fc, view, w, h);
        if (!polys.length) continue;
        // One path per brightness level, filled even-odd: the source contours
        // include dark-rift holes, and even-odd is what keeps them dark.
        ctx.beginPath();
        for (const poly of polys) {
          poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
        }
        ctx.fill('evenodd');
      }
      ctx.restore();
    }
  }

  /* --- 3. ground: everything below the horizon line --- */
  if (groundVisible && !camera) {
    const gTop = Math.max(yHor, -h);
    const gGrad = ctx.createLinearGradient(0, gTop, 0, gTop + h * 0.7);
    const lit = clamp01((sunAlt + 6) / 14);
    gGrad.addColorStop(0, rgb(mix([16, 18, 24], [58, 60, 56], lit)));
    gGrad.addColorStop(1, rgb(mix([6, 7, 10], [26, 28, 27], lit)));
    ctx.fillStyle = gGrad;
    ctx.fillRect(-w, gTop, 3 * w, 3 * h);
  }

  ctx.font = SKY_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  /* --- 4. alt/az grid (opt-in) --- */
  if (state.skyGrid) {
    ctx.strokeStyle = 'rgba(120,150,200,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const run of gridDrawList(view, w, h)) {
      run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    }
    ctx.stroke();
  }

  /* --- 5. constellation figures + stars --- */
  // Daylight washes stars out but must not erase them: this tab exists to
  // answer "where will that be tonight?", so a dusk sky keeps them faintly
  // legible rather than pretending the sky is empty.
  const daylight = clamp01((sunAlt + 12) / 14); // 0 by −12°, full by +2°
  const starDim = 1 - 0.72 * daylight;
  let starList = [];
  if (state.skyData) {
    ctx.strokeStyle = `rgba(132,166,220,${(0.26 * starDim).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const run of lineDrawList(state.skyData.lines, fc, view, w, h)) {
      run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    }
    ctx.stroke();

    starList = starDrawList(state.skyData.stars, fc, view, w, h, cullMargin);
    for (const s of starList) {
      const a = s.a * starDim;
      if (s.r > 1.7) drawGlow(ctx, s.x, s.y, s.r * 3.4, s.color, a * 0.55);
      ctx.globalAlpha = a;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.r > 3.4) drawFlare(ctx, s.x, s.y, s.r * 3.2, s.color, a * 0.30);
    }
    ctx.globalAlpha = 1;
  }

  /* --- 6. sun, moon, planets --- */
  const bodies = [];
  for (const b of skyBodies(when, lat, lon)) {
    if (b.alt < -0.5) continue;
    const p = project(b.az, b.alt, view, w, h);
    if (!p) continue;
    if (b.kind === 'sun') {
      const r = Math.max(7, 0.00465 * f * 2.4);
      drawGlow(ctx, p.x, p.y, r * 5, 'rgb(255,222,150)', 0.85);
      ctx.fillStyle = '#fff0c4';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      bodies.push({ ...b, x: p.x, y: p.y, r });
    } else if (b.kind === 'moon') {
      const r = Math.max(6, 0.00436 * f * 3);
      const ill = moonIllumination(when);
      const sun = skyBodies(when, lat, lon).find((s) => s.kind === 'sun');
      // The bright limb faces the sun. Taking the angle from two PROJECTED
      // points means projection distortion and AR roll are handled for free —
      // no separate position-angle formula to get wrong.
      let limb = 0;
      if (sun) {
        const toward = pointToward({ az: b.az, alt: b.alt }, { az: sun.az, alt: sun.alt }, 2);
        const tp = project(toward.az, toward.alt, view, w, h);
        if (tp) limb = Math.atan2(tp.y - p.y, tp.x - p.x);
      }
      drawMoon(ctx, p.x, p.y, r, ill.fraction, limb);
      bodies.push({ ...b, x: p.x, y: p.y, r, fraction: ill.fraction });
    } else {
      const st = PLANET_STYLE[b.abbr] || { color: '#f2f5fa', r: 3 };
      const r = st.r * Math.min(1.9, Math.max(0.8, Math.pow(70 / view.fov, 0.35)));
      drawGlow(ctx, p.x, p.y, r * 4, st.color, 0.55);
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (r > 3.4) drawFlare(ctx, p.x, p.y, r * 3, st.color, 0.32);
      bodies.push({ ...b, x: p.x, y: p.y, r });
    }
  }

  /* --- 7. horizon line + compass ticks --- */
  if (yHor !== null && yHor > -h && yHor < 2 * h && !camera) {
    const span = Math.hypot(w, h);
    const hGrad = ctx.createLinearGradient(0, yHor - 26, 0, yHor);
    hGrad.addColorStop(0, 'rgba(150,180,225,0)');
    hGrad.addColorStop(1, 'rgba(150,180,225,0.13)');
    ctx.fillStyle = hGrad;
    ctx.fillRect(-span, yHor - 26, w + 2 * span, 26);
  }
  if (yHor !== null && yHor > -h && yHor < 2 * h) {
    ctx.strokeStyle = 'rgba(168,196,236,0.6)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-Math.hypot(w, h), yHor);
    ctx.lineTo(w + Math.hypot(w, h), yHor);
    ctx.stroke();

    // Ticks every 15° of azimuth, taller at the eight named points.
    ctx.strokeStyle = 'rgba(168,196,236,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let az = 0; az < 360; az += 15) {
      const p = project(az, 0, view, w, h);
      if (!p || p.x < -20 || p.x > w + 20) continue;
      const len = az % 45 === 0 ? 7 : 4;
      ctx.moveTo(p.x, yHor - len);
      ctx.lineTo(p.x, yHor + len);
    }
    ctx.stroke();
  }

  /* --- 8. labels, collision-resolved in one pass --- */
  const cands = [];
  const measure = (text, font) => { ctx.font = font; return ctx.measureText(text).width; };

  // Cardinal points sit at the horizon and always win.
  if (yHor !== null && yHor > -20 && yHor < h + 20) {
    for (const [label, az] of CARDINALS) {
      const p = project(az, 0, view, w, h);
      if (!p || p.x < -20 || p.x > w + 20) continue;
      const primary = label.length === 1;
      const font = primary ? SKY_FONT_LG : SKY_FONT;
      const tw = measure(label, font);
      cands.push({
        x: p.x - tw / 2, y: Math.min(h - 14, yHor + 11), w: tw, h: 12,
        text: label, font, fill: primary ? 'rgba(214,230,255,0.95)' : 'rgba(190,210,240,0.7)',
      });
    }
  }
  // Bodies next, then bright stars, then constellations.
  for (const b of bodies) {
    const tw = measure(b.name, SKY_FONT_LG);
    cands.push({
      x: b.x - tw / 2, y: b.y + b.r + 9, w: tw, h: 12,
      text: b.name, font: SKY_FONT_LG, fill: 'rgba(232,240,255,0.95)',
    });
  }
  const magLimit = labelMagLimit(view.fov);
  for (const s of starList) {
    const text = s.name || (view.fov < 45 ? s.desig : null);
    if (!text || s.mag > magLimit) continue;
    // A star being extinguished by the atmosphere near the horizon must not
    // keep a full-strength label — a bright name floating over an invisible
    // star reads as a bug.
    if (s.a < 0.22) continue;
    const tw = measure(text, SKY_FONT);
    // Flip to the star's left rather than running off the right-hand edge.
    const right = s.x + s.r + 4;
    const x = right + tw > w - 2 ? s.x - s.r - 4 - tw : right;
    cands.push({
      x, y: s.y - 5, w: tw, h: 11, alpha: starDim * Math.min(1, s.a * 1.4),
      text, font: SKY_FONT, fill: s.name ? 'rgba(224,234,252,0.86)' : 'rgba(190,206,234,0.62)',
    });
  }
  if (state.skyData && state.skyData.consts) {
    for (const c of constellationLabelList(state.skyData.consts, fc, view, w, h)) {
      const text = c.text.toUpperCase();
      const tw = measure(text, SKY_FONT_CONST) + text.length * 1.2; // letter-spacing
      cands.push({
        x: c.x - tw / 2, y: c.y - 6, w: tw, h: 11, spaced: true, alpha: starDim,
        text, font: SKY_FONT_CONST, fill: 'rgba(150,178,224,0.5)',
      });
    }
  }
  // Never let a label hang off the canvas — except under AR roll, where the
  // drawing frame is rotated and the canvas rect is no longer the visible one.
  const inFrame = roll ? cands : cands.filter((c) => (
    c.x > -2 && c.x + c.w < w + 2 && c.y > -2 && c.y + c.h < h + 2
  ));
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  // Under AR roll the whole canvas is rotated, which would tilt every label
  // with the horizon — unreadable exactly when the phone is held up. Text is
  // billboarded instead: counter-rotated about its own centre so it stays
  // screen-upright while the sky behind it tilts.
  const billboard = roll ? (roll * Math.PI) / 180 : 0;
  for (const l of placeLabels(inFrame, 2, chromeBlockers(canvas, state, roll))) {
    ctx.font = l.font;
    ctx.fillStyle = l.fill;
    ctx.globalAlpha = l.alpha === undefined ? 1 : l.alpha;
    if (billboard) {
      ctx.save();
      ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
      ctx.rotate(billboard);
      ctx.translate(-l.w / 2, -l.h / 2);
    }
    const ox = billboard ? 0 : l.x;
    const oy = billboard ? 0 : l.y;
    if (l.spaced) {
      let x = ox;
      for (const ch of l.text) {
        ctx.fillText(ch, x, oy);
        x += ctx.measureText(ch).width + 1.2;
      }
    } else {
      ctx.fillText(l.text, ox, oy);
    }
    if (billboard) ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'middle';

  /* --- 9. hit list + selection reticle --- */
  skyPickList = starList.concat(bodies.map((b) => ({
    x: b.x, y: b.y, r: Math.max(b.r, 5), kind: b.kind, name: b.name,
    abbr: b.abbr, alt: b.alt, az: b.az, fraction: b.fraction,
  })));
  skyPickRoll = roll;
  skyPickSize = { w, h };

  const sel = state.skySelected;
  if (sel) {
    // Re-derive the position every frame from the object's sky coordinates, so
    // the reticle tracks correctly while panning, zooming, or scrubbing time.
    const live = sel.kind === 'star'
      ? { az: sel.az, alt: sel.alt }
      : (skyBodies(when, lat, lon).find((b) => b.name === sel.name) || sel);
    const p = project(live.az, live.alt, view, w, h);
    if (p) {
      const r = Math.max(11, (sel.r || 4) + 8);
      ctx.strokeStyle = 'rgba(255,214,110,0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        ctx.moveTo(p.x + dx * (r + 3), p.y + dy * (r + 3));
        ctx.lineTo(p.x + dx * (r + 8), p.y + dy * (r + 8));
      }
      ctx.stroke();
    }
  }

  ctx.textAlign = 'left';
  ctx.restore();

  /* --- chrome --- */
  const status = $('sky-status');
  if (status) {
    status.classList.toggle('hidden', !!state.skyData);
    if (!state.skyData) {
      status.textContent = state.skyDataError
        ? 'Star catalog unavailable — showing planets and horizon'
        : 'Loading star catalog…';
    }
  }
  const cap = $('sky-caption');
  if (cap) {
    const skyFmt = fmt(state.prefs.tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const arPrefix = state.ar && state.ar.active ? 'AR · ' : '';
    cap.textContent = `${arPrefix}${skyFmt.format(when)} · facing ${cardinalName(view.az)} · ${Math.round(view.fov)}° field`;
  }
  renderSkyInfo(state, when);

  const arBtn = $('sky-ar-btn');
  if (arBtn) arBtn.setAttribute('aria-pressed', state.ar && state.ar.active ? 'true' : 'false');
  const camBtn = $('sky-cam-btn');
  if (camBtn) {
    camBtn.classList.toggle('hidden', !(state.ar && state.ar.active));
    camBtn.setAttribute('aria-pressed', state.ar && state.ar.camera ? 'true' : 'false');
  }
  const gridBtn = $('sky-grid-btn');
  if (gridBtn) gridBtn.setAttribute('aria-pressed', state.skyGrid ? 'true' : 'false');
}

/* --------------------------- the info card --------------------------- */

const MOON_PHASE_LABEL = (frac, waxing) => {
  if (frac < 0.03) return 'New moon';
  if (frac > 0.97) return 'Full moon';
  if (Math.abs(frac - 0.5) < 0.06) return waxing ? 'First quarter' : 'Last quarter';
  const half = frac < 0.5 ? 'crescent' : 'gibbous';
  return `${waxing ? 'Waxing' : 'Waning'} ${half}`;
};

function renderSkyInfo(state, when) {
  const card = $('sky-info');
  if (!card) return;
  const sel = state.skySelected;
  if (!sel) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }
  const consts = (state.skyData && state.skyData.consts) || [];
  const title = sel.name || sel.desig || 'Star';
  const bits = [];

  if (sel.kind === 'star') {
    if (sel.name && sel.desig) bits.push(sel.desig);
    bits.push(`mag ${sel.mag.toFixed(1)}`);
    const abbr = sel.desig ? sel.desig.split(' ').pop() : null;
    const con = abbr && consts.find((c) => c[4] === abbr);
    if (con) bits.push(`in ${con[2]}`);
  } else if (sel.kind === 'moon') {
    const ill = moonIllumination(when);
    bits.push(MOON_PHASE_LABEL(ill.fraction, ill.waxing));
    bits.push(`${Math.round(ill.fraction * 100)}% lit`);
  } else if (sel.kind === 'planet') {
    bits.push('Planet');
  } else if (sel.kind === 'sun') {
    bits.push('The Sun');
  }
  bits.push(`${Math.round(sel.alt)}° up · ${cardinalName(sel.az)} ${Math.round(sel.az)}°`);

  card.replaceChildren();
  const main = document.createElement('div');
  main.className = 'sky-info-main';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sky-info-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '\u00d7';
  main.append(strong, close);
  const sub = document.createElement('div');
  sub.className = 'sky-info-sub';
  sub.textContent = bits.join(' \u00b7 ');
  card.append(main, sub);
  card.classList.remove('hidden');
}

/* ================= Shell state ================= */

export function setLoading(on) {
  document.body.classList.toggle('loading', on);
}

export function showView(state, route) {
  // When the forecast failed, the Conditions slot shows the error screen.
  const effective = route === 'conditions' && state.status === 'error' ? 'error' : route;
  document.querySelectorAll('main > .view').forEach((sec) => {
    sec.classList.toggle('hidden', sec.id !== `view-${effective}`);
  });
  document.querySelectorAll('.nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });
}

export function showNotice(text) {
  $('notice-text').textContent = text;
  $('notice').classList.remove('hidden');
}

export function hideNotice() {
  $('notice').classList.add('hidden');
}

/* ================= Share feedback ================= */

const CHECK_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,12.5 9.5,18 20,6.5"/></svg>';

export function shareFeedback() {
  const btn = $('share-btn');
  const original = btn.innerHTML;
  btn.innerHTML = CHECK_SVG;
  setTimeout(() => { btn.innerHTML = original; }, 1500);
}
