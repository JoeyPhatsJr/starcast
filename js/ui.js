// js/ui.js — all DOM rendering. Reads state, writes DOM; no fetching.
//
// Scrub performance contract: renderTiles/renderBanner/updatePlayhead only
// touch textContent / className / small innerHTML swaps on pre-existing
// nodes, so scrubbing the timeline stays cheap. Only day switches and data
// refreshes rebuild nodes (segments, tabs, charts).

import { scoreMetric, verdict, band } from './score.js';

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
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = 0; i < 140; i++) {
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      const r = 0.4 + Math.random() * 0.7;
      ctx.globalAlpha = 0.2 + Math.random() * 0.6;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
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
    t.sub.textContent = h.moonAlt < 0 ? 'Below horizon' : h.moonWaxing ? 'Waxing' : 'Waning';
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

  // Light Pollution — tap to edit (wired in app.js); keep the pencil glyph
  {
    const root = $('tile-bortle');
    root.className = `tile band-${band(scoreMetric('lightPollution', state.prefs.bortle))}`;
    root.querySelector('.t-value').textContent = String(state.prefs.bortle);
  }
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
  const now = Date.now();
  const isLive = now >= h.time && now < h.time + 3600000;
  $('live-ribbon').classList.toggle('hidden', !isLive);
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
  wrap.textContent = '';
  state.days.forEach((day, i) => {
    const btn = document.createElement('button');
    btn.className = `day-tab${i === state.selectedDay ? ' active' : ''}`;
    btn.dataset.day = String(i);
    btn.setAttribute('role', 'tab');
    btn.textContent = day.label;
    wrap.appendChild(btn);
  });
}

/* ================= Charts =================
 * Inline SVG line charts over the next 72 hours. The SVG stretches
 * (preserveAspectRatio="none") but strokes use vector-effect:
 * non-scaling-stroke, and text labels live in HTML overlays so nothing
 * distorts. Height is a fixed 120px so vertical positions map 1:1. */

const CHART_W = 720;
const CHART_H = 120;

function buildChart(containerId, values, times, tz, opts) {
  const el = $(containerId);
  const n = values.length;
  if (n < 2) { el.textContent = ''; return; }
  const { min, max, color, area } = opts;
  const range = max - min || 1;
  const X = (i) => (i / (n - 1)) * CHART_W;
  const Y = (v) => CHART_H - ((v - min) / range) * CHART_H;

  const pts = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');

  // Vertical dashed lines + weekday labels at each local midnight
  let vlines = '';
  let xlabs = '';
  for (let i = 0; i < n; i++) {
    if (localHour(times[i], tz) === 0) {
      const x = X(i);
      vlines += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${CHART_H}" stroke="#2a3a63" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`;
      xlabs += `<span class="xlab" style="left:${((x / CHART_W) * 100).toFixed(2)}%">${fmtWeekdayShort(times[i], tz)}</span>`;
    }
  }

  // 3 horizontal dashed gridlines at 25/50/75% with value labels
  let hlines = '';
  let ylabs = '';
  for (const f of [0.25, 0.5, 0.75]) {
    const y = CHART_H * (1 - f);
    const v = min + range * f;
    hlines += `<line x1="0" y1="${y}" x2="${CHART_W}" y2="${y}" stroke="#2a3a63" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
    ylabs += `<span class="ylab" style="top:${y}px">${Math.round(v)}</span>`;
  }

  let series;
  if (area) {
    const d = `M 0 ${CHART_H} L ${pts.split(' ').map((p) => p.replace(',', ' ')).join(' L ')} L ${CHART_W} ${CHART_H} Z`;
    series =
      `<path d="${d}" fill="${color}" fill-opacity="0.25" stroke="none"/>` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  } else {
    series = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }

  el.innerHTML =
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">` +
    hlines + vlines + series +
    `</svg>` + ylabs + xlabs;
}

export function renderCharts(state) {
  if (!state.hours.length) return;
  const tz = state.prefs.tz;
  const metric = state.prefs.units === 'metric';
  const start = Math.max(0, state.currentHourIndex);
  const slice = state.hours.slice(start, start + 72);
  if (slice.length < 2) return;
  const times = slice.map((h) => h.time);

  $('chart-temp-title').textContent = `Temperature (°${metric ? 'C' : 'F'})`;
  $('chart-wind-title').textContent = `Wind (${metric ? 'km/h' : 'mph'})`;

  buildChart('chart-cloud', slice.map((h) => h.cloud), times, tz, {
    min: 0, max: 100, color: 'var(--bad)', area: true,
  });

  const temps = slice.map((h) => h.temp);
  buildChart('chart-temp', temps, times, tz, {
    min: Math.min(...temps) - 5, max: Math.max(...temps) + 5, color: 'var(--accent)',
  });

  const winds = slice.map((h) => h.wind);
  buildChart('chart-wind', winds, times, tz, {
    min: 0, max: Math.max(...winds) + 5, color: 'var(--good)',
  });
}

/* ================= Settings ================= */

export function renderSettings(state) {
  $('loc-name').textContent = state.prefs.name || '—';
  $('loc-coords').textContent =
    Number.isFinite(state.prefs.lat)
      ? `${state.prefs.lat.toFixed(4)}, ${state.prefs.lon.toFixed(4)}`
      : '—';

  document.querySelectorAll('#bortle-chips .chip').forEach((chip) => {
    const b = Number(chip.dataset.bortle);
    const selected = b === state.prefs.bortle;
    chip.className = 'chip' + (selected ? ` selected band-${band(scoreMetric('lightPollution', b))}` : '');
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
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

export function flashBortleCard() {
  const card = $('card-bortle');
  card.classList.remove('flash');
  void card.offsetWidth; // restart the animation
  card.classList.add('flash');
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
