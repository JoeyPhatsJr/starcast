// js/ui.js — all DOM rendering. Reads state, writes DOM; no fetching.
//
// Scrub performance contract: renderTiles/renderBanner/updatePlayhead only
// touch textContent / className / small innerHTML swaps on pre-existing
// nodes, so scrubbing the timeline stays cheap. Only day switches and data
// refreshes rebuild nodes (segments, tabs, charts).

import { scoreMetric, verdict, band, WEIGHTS } from './score.js';
import { activeShowers, milkyWayPeak, phaseName, kpNeeded } from './tonight.js';
import { planetNightEvents } from './astro.js';
import { nightHoursOf, bestWindowIn } from './logic.js';

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

export function getSelectedHour(state) {
  const day = state.days[state.selectedDay];
  if (!day || !day.hourIndices.length) return null;
  const pos = Math.min(state.selectedHour, day.hourIndices.length - 1);
  return state.hours[day.hourIndices[pos]];
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
  strip.querySelectorAll('.seg').forEach((n) => n.remove());
  const day = state.days[state.selectedDay];
  if (!day) return;
  const playhead = $('playhead');
  strip.setAttribute('aria-valuemax', String(day.hourIndices.length - 1));
  for (const idx of day.hourIndices) {
    const h = state.hours[idx];
    const seg = document.createElement('div');
    seg.className = `seg band-${band(h.score)}${h.isDay === 1 ? ' daylight' : ''}`;
    strip.insertBefore(seg, playhead);
  }
  updatePlayhead(state);
}

export function updatePlayhead(state) {
  const day = state.days[state.selectedDay];
  if (!day || !day.hourIndices.length) return;
  const n = day.hourIndices.length;
  const pos = Math.min(state.selectedHour, n - 1);
  const playhead = $('playhead');
  playhead.style.left = `${((pos + 0.5) / n) * 100}%`;
  playhead.classList.remove('hidden');
  const h = state.hours[day.hourIndices[pos]];
  $('timeline-label').textContent = `▾ ${fmtTime(h.time, state.prefs.tz)}`;
  $('timeline-strip').setAttribute('aria-valuenow', String(pos));
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
  for (const day of state.days.slice(0, state.forecastDays || 7)) {
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
      `<div class="panel fc-day">` +
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
