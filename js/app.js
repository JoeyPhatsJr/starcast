// js/app.js — entry point: state, boot sequence, routing, event wiring.

import {
  fetchOpenMeteo, fetch7Timer, geocode, parseOpenMeteo,
  nearestAstro, heuristicSeeing, heuristicTransparency,
  fetchAirQuality, fetchCloudModels, fetchPressureWinds, reverseGeocode,
  fetchCloudOutlook,
} from './weather.js';
import {
  sunAltitude, moonAltitude, moonIllumination, visiblePlanets,
  altitudeCrossings, nextLunations,
} from './astro.js';
import { overallScore } from './score.js';
import { fetchLightPollution } from './lightpollution.js';
import { fetchKpForecast } from './tonight.js';
import { parseShareCoords, groupByLocalDate, buildICS, nightCloudMean } from './logic.js';
import { dragView, zoomView } from './skymap.js';
import { orientationToView, smoothView, headingOffset } from './armath.js';
import { declination, decimalYear } from './wmm.js';
import * as UI from './ui.js';

const PREFS_KEY = 'starcast:prefs';
const NYC = { lat: 40.7128, lon: -74.0060, name: 'New York City' };
const REFRESH_MS = 30 * 60 * 1000;

const state = {
  prefs: {
    lat: null, lon: null, name: '', tz: 'America/New_York',
    bortle: 5, units: 'imperial', // bortle is always the atlas-measured value
    saved: [], night: false, cb: false,
  },
  hours: [],
  days: [],
  daily: [],
  selectedDay: 0,
  selectedHour: 0,
  currentHourIndex: 0,
  chartRange: 72, // hours shown on the Charts tab
  lightPollution: null, // { ratio, mpsas, bortle } from the atlas, if fetched
  kp: null, // { maxKp, time } from NOAA SWPC, if fetched
  lunations: [], // upcoming new/full moons
  spotCompare: null, // [{ name, cloud }] tonight's outlook per saved spot
  forecastDays: 7, // Forecast grid span (7 or 14)
  lastFetch: null, // epoch ms of the last non-cached Open-Meteo success
  offlineData: false, // true when showing the SW's cached fallback
  status: 'loading', // loading | ready | error
  sky: { az: 180, alt: 25, fov: 70 }, // Sky tab view direction/zoom
  skyData: null, // star/constellation catalog, lazy-fetched on first Sky visit
  skyDataError: false, // true when the last sky.json fetch attempt failed
  ar: { active: false, camera: false, decl: 0, offset: null, view: null, lastEventAt: 0 },
};

let route = 'conditions';
let astroSeries = null; // last successful 7Timer series (survives refetches)
let aodMap = null; // epoch ms → aerosol optical depth
let spreadMap = null; // epoch ms → cross-model cloud spread (%)
let shearMap = null; // epoch ms → { w250, w500 } upper-air winds (km/h)

/* ================= Prefs ================= */

function loadPrefs() {
  // Private-mode Safari throws on localStorage access — always guard.
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') Object.assign(state.prefs, saved);
    }
  } catch (e) { /* fall through to defaults */ }
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(state.prefs.bortle)) state.prefs.bortle = 5;
  if (!['imperial', 'metric'].includes(state.prefs.units)) state.prefs.units = 'imperial';
  if (!Array.isArray(state.prefs.saved)) state.prefs.saved = [];
  state.prefs.saved = state.prefs.saved
    .filter((l) => l && Number.isFinite(l.lat) && Number.isFinite(l.lon) && typeof l.name === 'string')
    .slice(0, 8);
  if (typeof state.prefs.night !== 'boolean') state.prefs.night = false;
  if (typeof state.prefs.cb !== 'boolean') state.prefs.cb = false;
  try {
    const t = Number(localStorage.getItem('starcast:lastFetch'));
    if (Number.isFinite(t) && t > 0) state.lastFetch = t;
  } catch (e) { /* ignore */ }
}

function savePrefs() {
  try {
    // bortle persists so an offline start reuses the last measured value.
    const { lat, lon, name, tz, bortle, units, saved, night, cb } = state.prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lat, lon, name, tz, bortle, units, saved, night, cb }));
  } catch (e) { /* private mode — prefs just won't persist */ }
}

/** Shared links: ?lat=..&lon=..&name=.. opens that location directly. */
function parseShareParams() {
  const coords = parseShareCoords(location.search);
  if (coords) {
    Object.assign(state.prefs, coords);
    savePrefs();
  }
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
}

/* ================= Spot comparison ================= */

let spotSeq = 0;

/**
 * "Which of my saved spots is best tonight?" — one lightweight cloud fetch
 * per saved location, averaged over that spot's night hours (sun below the
 * horizon there, next 14 h). Fire-and-forget; needs ≥2 saved spots.
 */
async function refreshSpotCompare() {
  const seq = ++spotSeq;
  const spots = state.prefs.saved;
  if (spots.length < 2) {
    state.spotCompare = null;
    UI.renderSpotCompare(state);
    return;
  }
  const now = Date.now();
  const results = await Promise.allSettled(spots.map(async (spot) => {
    const hours = await fetchCloudOutlook(spot.lat, spot.lon);
    const cloud = nightCloudMean(hours, now, (t) => sunAltitude(new Date(t), spot.lat, spot.lon) < 0);
    return { name: spot.name, cloud };
  }));
  if (seq !== spotSeq) return;
  const list = results
    .filter((r) => r.status === 'fulfilled' && r.value.cloud != null)
    .map((r) => r.value)
    .sort((a, b) => a.cloud - b.cloud);
  state.spotCompare = list.length >= 2 ? list : null;
  UI.renderSpotCompare(state);
}

/* ================= Light pollution (auto Bortle) ================= */

let lpSeq = 0;

async function refreshLightPollution() {
  const seq = ++lpSeq;
  state.lightPollution = null;
  UI.renderSettings(state);
  try {
    const lp = await fetchLightPollution(state.prefs.lat, state.prefs.lon);
    if (seq !== lpSeq) return;
    state.lightPollution = lp;
    // Fully automatic: the measured value is always applied.
    if (state.prefs.bortle !== lp.bortle) {
      state.prefs.bortle = lp.bortle;
      savePrefs();
      if (state.status === 'ready') {
        rescoreAll();
        renderData();
        return;
      }
    }
    UI.renderSettings(state);
    if (state.status === 'ready') UI.renderTiles(state);
  } catch (e) {
    // Atlas unreachable or out of coverage — keep the last measured value.
    if (seq === lpSeq) UI.renderSettings(state);
  }
}

/* ================= Location ================= */

function geolocate() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: Number(pos.coords.latitude.toFixed(4)),
        lon: Number(pos.coords.longitude.toFixed(4)),
        name: 'My Location',
      }),
      (err) => reject(err),
      { timeout: 10000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

/** Replace the generic "My Location" label with a real place name. */
function labelCurrentLocation() {
  const { lat, lon } = state.prefs;
  reverseGeocode(lat, lon)
    .then((name) => {
      // Only apply if the user hasn't since moved somewhere else.
      if (state.prefs.lat === lat && state.prefs.lon === lon && state.prefs.name === 'My Location') {
        state.prefs.name = name;
        savePrefs();
        UI.renderSettings(state);
        UI.renderSavedLocations(state);
      }
    })
    .catch(() => { /* "My Location" is a fine fallback */ });
}

async function resolveLocation() {
  if (Number.isFinite(state.prefs.lat) && Number.isFinite(state.prefs.lon)) return;
  try {
    Object.assign(state.prefs, await geolocate());
    labelCurrentLocation();
  } catch (e) {
    // Denied, timed out, or insecure context → NYC default + dismissible notice.
    Object.assign(state.prefs, NYC);
    UI.showNotice('Using default location — set yours in Settings.');
  }
  savePrefs();
}

/* ================= Data pipeline ================= */

function ctxFor(hour) {
  return {
    bortle: state.prefs.bortle,
    moonAltitude: hour.moonAlt,
    sunAltitude: hour.sunAlt,
    moonIllum: hour.moonIllum,
  };
}

function rescoreAll() {
  for (const h of state.hours) h.score = overallScore(h, ctxFor(h));
}

/** Patch seeing/transparency from the 7Timer series where it has coverage. */
function applyAstroSeries() {
  if (!astroSeries) return;
  for (const h of state.hours) {
    const point = nearestAstro(astroSeries, h.time);
    if (point) {
      h.seeing = point.seeing;
      h.transparency = point.transparency;
      h.seeingIsEstimate = false;
    }
  }
}

/** Patch measured aerosol optical depth in; upgrade estimated transparency. */
function applyAodMap() {
  if (!aodMap) return;
  for (const h of state.hours) {
    const v = aodMap.get(h.time);
    if (v != null) {
      h.aod = v;
      if (h.seeingIsEstimate) h.transparency = heuristicTransparency(h);
    }
  }
}

/** Patch cross-model cloud spread in (confidence signal, not scored). */
function applySpreadMap() {
  if (!spreadMap) return;
  for (const h of state.hours) {
    const v = spreadMap.get(h.time);
    if (v != null) h.cloudSpread = v;
  }
}

/** Patch upper-air winds in; upgrade estimated seeing to shear-based. */
function applyShearMap() {
  if (!shearMap) return;
  for (const h of state.hours) {
    const v = shearMap.get(h.time);
    if (v) {
      h.w250 = v.w250;
      h.w500 = v.w500;
      if (h.seeingIsEstimate) h.seeing = heuristicSeeing(h);
    }
  }
}

function buildDays() {
  const tz = state.prefs.tz;
  const byDate = groupByLocalDate(state.hours.map((h) => h.time), (t) => UI.fmtISODate(t, tz));
  const todayKey = UI.fmtISODate(Date.now(), tz);
  const dailyByKey = new Map(state.daily.map((d) => [UI.fmtISODate(d.date, tz), d]));
  const { lat, lon } = state.prefs;
  state.days = [...byDate.entries()].map(([key, idxs]) => {
    const d = dailyByKey.get(key);
    const first = state.hours[idxs[0]].time;
    const isToday = key === todayKey;
    const dayEnd = state.hours[idxs[idxs.length - 1]].time + 3600000;

    // Moonrise/moonset and astronomical-darkness bounds for the Forecast
    // grid headers — sign-crossing scans over the day's span.
    const moonX = altitudeCrossings((dt) => moonAltitude(dt, lat, lon), first, dayEnd, 0);
    const sunX = altitudeCrossings((dt) => sunAltitude(dt, lat, lon), first, dayEnd, -18);
    const riseX = moonX.find((c) => c.rising);
    const setX = moonX.find((c) => !c.rising);
    const darkEndX = sunX.find((c) => c.rising); // morning: sun climbs past −18°
    const darkStartX = sunX.find((c) => !c.rising); // evening: astro dark begins

    return {
      key,
      label: isToday ? 'Today' : UI.fmtWeekdayShort(first, tz),
      isToday,
      sunrise: d ? d.sunrise : null,
      sunset: d ? d.sunset : null,
      hourIndices: idxs,
      moonRise: riseX ? riseX.time : null,
      moonSet: setX ? setX.time : null,
      darkEnd: darkEndX ? darkEndX.time : null,
      darkStart: darkStartX ? darkStartX.time : null,
      neverDark: sunX.length === 0 && sunAltitude(new Date(first + 12 * 3600000), lat, lon) > -18,
    };
  });
}

function updateCurrentHour() {
  const now = Date.now();
  const idx = state.hours.findIndex((h) => now >= h.time && now < h.time + 3600000);
  state.currentHourIndex = Math.max(0, idx);
}

function buildData(omData) {
  const parsed = parseOpenMeteo(omData, state.prefs.units);
  state.prefs.tz = parsed.tz || state.prefs.tz;
  savePrefs();
  state.hours = parsed.hours;
  state.daily = parsed.daily;

  const { lat, lon } = state.prefs;
  for (const h of state.hours) {
    const d = new Date(h.time);
    h.sunAlt = sunAltitude(d, lat, lon);
    h.moonAlt = moonAltitude(d, lat, lon);
    const mi = moonIllumination(d);
    h.moonIllum = mi.fraction;
    h.moonWaxing = mi.waxing;
    h.planets = visiblePlanets(d, lat, lon);
    h.seeing = heuristicSeeing(h);
    h.transparency = heuristicTransparency(h);
    h.seeingIsEstimate = true;
  }

  applyAstroSeries();
  applyAodMap();
  applySpreadMap();
  applyShearMap();
  rescoreAll();
  updateCurrentHour();
  buildDays();
  state.lunations = nextLunations(new Date(), 45);
}

/** Clamp (or, on first load, pick today + the current hour) the selection. */
function initSelection(first) {
  if (!state.days.length) return;
  if (first) {
    const todayIdx = state.days.findIndex((d) => d.isToday);
    state.selectedDay = todayIdx >= 0 ? todayIdx : 0;
    const day = state.days[state.selectedDay];
    const pos = day.hourIndices.indexOf(state.currentHourIndex);
    state.selectedHour = pos >= 0 ? pos : 0;
  }
  state.selectedDay = Math.min(state.selectedDay, state.days.length - 1);
  const day = state.days[state.selectedDay];
  state.selectedHour = Math.min(state.selectedHour, day.hourIndices.length - 1);
}

/* ================= Rendering ================= */

function renderSelection() {
  UI.renderBanner(state);
  UI.renderTiles(state);
  UI.updatePlayhead(state);
  if (route === 'sky') UI.renderSky(state);
}

function renderSelectionExtras() {
  if (UI.isBreakdownOpen()) UI.renderBreakdown(state);
}

function renderData() {
  UI.renderDayTabs(state);
  UI.renderTimelineSegments(state);
  renderSelection();
  renderSelectionExtras();
  UI.renderTonight(state);
  UI.renderDataAge(state);
  UI.renderSettings(state);
  UI.renderSavedLocations(state);
  if (route === 'charts') UI.renderCharts(state);
  if (route === 'forecast') UI.renderForecast(state);
}

/* ================= Fetch orchestration ================= */

let fetchSeq = 0; // discard stale responses after a location/unit change

async function refetchAll({ silent = false, first = false } = {}) {
  const seq = ++fetchSeq;
  if (!silent) {
    state.status = 'loading';
    UI.setLoading(true);
    UI.showView(state, route);
  }

  if (first) {
    // Location changed: stale side-channel data must not leak across places.
    astroSeries = null;
    aodMap = null;
    spreadMap = null;
    shearMap = null;
    // Fire-and-forget: measured Bortle from the atlas.
    refreshLightPollution();
  }
  refreshSpotCompare();

  const omPromise = fetchOpenMeteo(state.prefs.lat, state.prefs.lon, state.prefs.units);
  // Side-channel fetches run in parallel and NEVER block first paint: each
  // patches in whenever (and if ever) it lands; failures are absorbed.
  fetch7Timer(state.prefs.lat, state.prefs.lon)
    .then((series) => {
      if (seq !== fetchSeq) return;
      astroSeries = series;
      if (state.status === 'ready') {
        applyAstroSeries();
        rescoreAll();
        renderData();
      }
    })
    .catch(() => { /* keep heuristic estimates */ });

  fetchAirQuality(state.prefs.lat, state.prefs.lon)
    .then((map) => {
      if (seq !== fetchSeq) return;
      aodMap = map;
      if (state.status === 'ready') {
        applyAodMap();
        rescoreAll();
        renderData();
      }
    })
    .catch(() => { /* humidity-based heuristic stands */ });

  fetchCloudModels(state.prefs.lat, state.prefs.lon)
    .then((map) => {
      if (seq !== fetchSeq) return;
      spreadMap = map;
      if (state.status === 'ready') {
        applySpreadMap();
        UI.renderTonight(state);
      }
    })
    .catch(() => { /* confidence line just won't show */ });

  fetchPressureWinds(state.prefs.lat, state.prefs.lon)
    .then((map) => {
      if (seq !== fetchSeq) return;
      shearMap = map;
      if (state.status === 'ready') {
        applyShearMap();
        rescoreAll();
        renderData();
      }
    })
    .catch(() => { /* cloud+wind seeing heuristic stands */ });

  fetchKpForecast()
    .then((kp) => {
      state.kp = kp;
      if (state.status === 'ready') UI.renderTonight(state);
    })
    .catch(() => { /* aurora line just won't show */ });

  const [om] = await Promise.allSettled([omPromise]);
  if (seq !== fetchSeq) return;

  if (om.status === 'fulfilled') {
    // Staleness bookkeeping: a cache-fallback response (SW header) means
    // we're offline showing saved data — say so instead of pretending.
    if (om.value._fromCache) {
      state.offlineData = true;
      UI.showNotice('Offline — showing your last saved forecast.');
    } else {
      state.offlineData = false;
      state.lastFetch = Date.now();
      try { localStorage.setItem('starcast:lastFetch', String(state.lastFetch)); } catch (e) { /* ok */ }
    }
    buildData(om.value);
    initSelection(first);
    state.status = 'ready';
    UI.setLoading(false);
    renderData();
    UI.showView(state, route);
  } else if (!silent) {
    state.status = 'error';
    UI.setLoading(false);
    UI.showView(state, route);
  }
  // Silent refresh failure: keep showing the data we already have.
}

/* ================= Sky map catalog (lazy, fire-and-forget) ================= */

let skyDataPromise = null;
function ensureSkyData() {
  if (state.skyData || skyDataPromise) return;
  state.skyDataError = false;
  skyDataPromise = fetch('./data/sky.json')
    .then((r) => {
      if (!r.ok) throw new Error(`sky.json ${r.status}`);
      return r.json();
    })
    .then((data) => {
      state.skyData = data;
      state.skyDataError = false;
      if (route === 'sky') UI.renderSky(state);
    })
    .catch(() => {
      skyDataPromise = null; // allow retry on next visit to the tab
      state.skyDataError = true;
      if (route === 'sky') UI.renderSky(state);
    });
}

/* ================= Routing ================= */

const ROUTES = { '': 'conditions', '#/': 'conditions', '#/sky': 'sky', '#/forecast': 'forecast', '#/charts': 'charts', '#/settings': 'settings', '#/help': 'help' };

function applyRoute() {
  route = ROUTES[location.hash] || 'conditions';
  UI.showView(state, route);
  if (state.status === 'ready') {
    if (route === 'charts') UI.renderCharts(state);
    if (route === 'forecast') UI.renderForecast(state);
    // Re-center the active day tab — centering math needs a visible scroller.
    if (route === 'conditions') UI.renderDayTabs(state);
  }
  // Sky renders bodies + horizon from the system clock even before/without
  // forecast data, so it doesn't gate on state.status.
  if (route === 'sky') { ensureSkyData(); UI.renderSky(state); }
}

/* ================= Interactions ================= */

function setHour(pos) {
  if (!Number.isFinite(pos)) return; // e.g. a scrub computed against a hidden strip
  const day = state.days[state.selectedDay];
  if (!day) return;
  const clamped = Math.max(0, Math.min(day.hourIndices.length - 1, pos));
  if (clamped === state.selectedHour) return;
  state.selectedHour = clamped;
  renderSelection();
  renderSelectionExtras();
}

function setDay(i) {
  if (i === state.selectedDay || !state.days[i]) return;
  state.selectedDay = i;
  // Keep the same scrub hour across days (clamped to the day's length).
  state.selectedHour = Math.min(state.selectedHour, state.days[i].hourIndices.length - 1);
  UI.renderDayTabs(state);
  UI.renderTimelineSegments(state);
  renderSelection();
  renderSelectionExtras();
  UI.renderTonight(state);
}

function wireTimeline() {
  const strip = document.getElementById('timeline-strip');
  let dragging = false;

  const hourFromEvent = (e) => {
    const day = state.days[state.selectedDay];
    if (!day) return 0;
    const rect = strip.getBoundingClientRect();
    const n = day.hourIndices.length;
    return Math.floor(((e.clientX - rect.left) / rect.width) * n);
  };

  strip.addEventListener('pointerdown', (e) => {
    if (state.status !== 'ready') return;
    dragging = true;
    strip.setPointerCapture(e.pointerId);
    setHour(hourFromEvent(e));
  });
  strip.addEventListener('pointermove', (e) => {
    if (dragging) setHour(hourFromEvent(e));
  });
  strip.addEventListener('pointerup', () => { dragging = false; });
  strip.addEventListener('pointercancel', () => { dragging = false; });

  // Keyboard support on the slider strip
  strip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { setHour(state.selectedHour - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setHour(state.selectedHour + 1); e.preventDefault(); }
  });
}

function wireDayTabs() {
  document.getElementById('day-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.day-tab');
    if (tab) setDay(Number(tab.dataset.day));
  });
}

// Swipe left/right anywhere on the tile grid to change day — the natural
// mobile gesture. Horizontal-dominant swipes only, so vertical scrolling
// is never hijacked.
function wireSwipe() {
  const zone = document.getElementById('tile-grid');
  let sx = 0;
  let sy = 0;
  let tracking = false;
  zone.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    tracking = true;
  }, { passive: true });
  zone.addEventListener('touchend', (e) => {
    if (!tracking || state.status !== 'ready') return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) > 55 && Math.abs(dx) > 2 * Math.abs(dy)) {
      setDay(state.selectedDay + (dx < 0 ? 1 : -1));
    }
  }, { passive: true });
}

function wireShare() {
  document.getElementById('share-btn').addEventListener('click', async () => {
    // Share links carry the location, so the recipient opens YOUR spot.
    const { lat, lon, name } = state.prefs;
    const base = location.origin + location.pathname;
    const url = Number.isFinite(lat)
      ? `${base}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&name=${encodeURIComponent(name || '')}`
      : base;
    const payload = {
      title: 'Starcast',
      text: `Is it good to stargaze${name ? ` at ${name}` : ''} tonight?`,
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(payload);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(payload.url);
        UI.shareFeedback();
      }
    } catch (e) { /* user cancelled the share sheet — fine */ }
  });
}

function wireSettings() {
  // Light Pollution tile → Settings, where the measured value is shown
  document.getElementById('tile-bortle').addEventListener('click', () => {
    location.hash = '#/settings';
  });

  // Units segmented control (scoped — the Charts range buttons are .seg-btn too)
  document.querySelectorAll('#card-units .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.units === state.prefs.units) return;
      state.prefs.units = btn.dataset.units;
      savePrefs();
      UI.renderSettings(state);
      refetchAll(); // temperature/wind units change server-side
    });
  });

  // Re-run geolocation on demand
  document.getElementById('btn-geoloc').addEventListener('click', async () => {
    try {
      Object.assign(state.prefs, await geolocate());
      savePrefs();
      labelCurrentLocation();
      UI.hideNotice();
      UI.renderSettings(state);
      refetchAll({ first: true });
    } catch (e) {
      UI.showNotice("Couldn't get your location — check browser permissions.");
    }
  });

  // City search (300ms debounce) + tappable results
  const input = document.getElementById('city-search');
  let debounceTimer = null;
  let searchSeq = 0;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      UI.renderSearchResults(null);
      return;
    }
    debounceTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const results = await geocode(query);
        if (seq === searchSeq) UI.renderSearchResults(results, query);
      } catch (e) {
        if (seq === searchSeq) UI.renderSearchResults([], query);
      }
    }, 300);
  });

  document.getElementById('search-results').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-lat]');
    if (!li) return;
    state.prefs.lat = Number(li.dataset.lat);
    state.prefs.lon = Number(li.dataset.lon);
    state.prefs.name = li.dataset.name;
    savePrefs();
    input.value = '';
    UI.renderSearchResults(null);
    UI.hideNotice();
    UI.renderSettings(state);
    astroSeries = null;
    refetchAll({ first: true }); // new place → re-select today + current hour there
  });
}

function wireBreakdown() {
  const banner = document.getElementById('banner');
  const toggle = () => {
    if (state.status === 'ready') UI.toggleBreakdown(state);
  };
  banner.addEventListener('click', toggle);
  banner.addEventListener('keydown', (e) => {
    if (e.target !== banner) return; // don't hijack the calendar button
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}

// "Add to calendar": download an .ics for the night's best window — the
// closest thing to notifications a static site can offer.
function wireCalendarExport() {
  document.getElementById('cal-btn').addEventListener('click', (e) => {
    e.stopPropagation(); // the banner click would open the breakdown
    const win = UI.bestWindowFor(state);
    if (!win) return;
    const ics = buildICS({
      startMs: win.hours[0].time,
      endMs: win.hours[win.hours.length - 1].time + 3600000,
      level: win.level,
      name: state.prefs.name || 'your location',
      url: location.origin + location.pathname,
      nowMs: Date.now(),
    });
    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'starcast-window.ics';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function wireSavedLocations() {
  document.getElementById('btn-save-loc').addEventListener('click', () => {
    const { lat, lon, name } = state.prefs;
    if (!Number.isFinite(lat)) return;
    const dup = state.prefs.saved.some(
      (l) => Math.abs(l.lat - lat) < 0.005 && Math.abs(l.lon - lon) < 0.005,
    );
    if (!dup) {
      state.prefs.saved.unshift({ name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon });
      state.prefs.saved = state.prefs.saved.slice(0, 8);
      savePrefs();
      refreshSpotCompare();
    }
    UI.renderSavedLocations(state);
  });

  document.getElementById('saved-locs').addEventListener('click', (e) => {
    if (e.target.closest('input')) return; // editing in progress — don't switch
    const ren = e.target.closest('[data-rename]');
    if (ren) {
      const li = ren.closest('li');
      if (li.querySelector('input')) return;
      const i = Number(ren.dataset.rename);
      const loc = state.prefs.saved[i];
      if (!loc) return;
      // Inline rename: swap the name for an input; Enter/blur commits,
      // Escape cancels.
      const nameSpan = li.querySelector('span');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = loc.name;
      input.maxLength = 40;
      input.className = 'rename-input';
      nameSpan.replaceWith(input);
      input.focus();
      input.select();
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = ''; input.blur(); }
      });
      input.addEventListener('blur', () => {
        const name = input.value.trim();
        if (name) {
          loc.name = name.slice(0, 40);
          // If it's the current location, rename that too.
          if (Math.abs(loc.lat - state.prefs.lat) < 0.005 && Math.abs(loc.lon - state.prefs.lon) < 0.005) {
            state.prefs.name = loc.name;
          }
          savePrefs();
          refreshSpotCompare();
        }
        UI.renderSettings(state);
        UI.renderSavedLocations(state);
      }, { once: true });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      state.prefs.saved.splice(Number(del.dataset.del), 1);
      savePrefs();
      UI.renderSavedLocations(state);
      refreshSpotCompare();
      return;
    }
    const li = e.target.closest('li[data-idx]');
    if (!li) return;
    const loc = state.prefs.saved[Number(li.dataset.idx)];
    if (!loc) return;
    state.prefs.lat = loc.lat;
    state.prefs.lon = loc.lon;
    state.prefs.name = loc.name;
    savePrefs();
    UI.hideNotice();
    UI.renderSettings(state);
    UI.renderSavedLocations(state);
    refetchAll({ first: true });
  });
}

function wireAppearance() {
  const setNight = (on) => {
    state.prefs.night = on;
    savePrefs();
    UI.applyAppearance(state);
  };
  document.getElementById('night-btn').addEventListener('click', () => setNight(!state.prefs.night));
  document.getElementById('toggle-night').addEventListener('click', () => setNight(!state.prefs.night));
  document.getElementById('toggle-cb').addEventListener('click', () => {
    state.prefs.cb = !state.prefs.cb;
    savePrefs();
    UI.applyAppearance(state);
  });
}

let skyRaf = 0;
function scheduleSkyRender() {
  if (skyRaf) return;
  skyRaf = requestAnimationFrame(() => {
    skyRaf = 0;
    UI.renderSky(state);
  });
}

function wireSky() {
  const canvas = document.getElementById('sky-canvas');
  if (!canvas) return;
  const ptrs = new Map(); // pointerId → last {x, y}
  let lastPinchDist = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    ptrs.set(e.pointerId, cur);
    if (ptrs.size === 1) {
      if (state.ar.active) return;
      state.sky = dragView(state.sky, cur.x - prev.x, cur.y - prev.y, canvas.clientWidth);
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist > 0) state.sky = zoomView(state.sky, dist / lastPinchDist);
      lastPinchDist = dist;
    }
    scheduleSkyRender();
  });

  const endPtr = (e) => {
    ptrs.delete(e.pointerId);
    lastPinchDist = 0;
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.sky = zoomView(state.sky, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      scheduleSkyRender();
    },
    { passive: false }
  );

  let skyResizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(skyResizeTimer);
    skyResizeTimer = setTimeout(() => {
      if (route === 'sky') UI.renderSky(state);
    }, 150);
  });
}

// --- AR mode ---------------------------------------------------------------
let skyToastTimer = 0;
function showSkyToast(msg) {
  const el = document.getElementById('sky-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(skyToastTimer);
  skyToastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function screenAngle() {
  return (screen.orientation && Number.isFinite(screen.orientation.angle))
    ? screen.orientation.angle
    : (Number(window.orientation) || 0);
}

let arHasAbsolute = false;
let arSensorTimer = 0;

function onOrientation(e) {
  if (!state.ar.active || e.alpha === null || e.alpha === undefined) return;
  // Prefer absolute events; once one arrives, ignore the relative stream.
  const isAbsolute = e.type === 'deviceorientationabsolute' || e.absolute === true;
  if (isAbsolute) arHasAbsolute = true;
  else if (arHasAbsolute) return;

  let alpha = e.alpha;
  if (!isAbsolute && typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    // iOS: fuse the absolute (noisy) compass with the smooth (relative) gyro alpha
    state.ar.offset = headingOffset(state.ar.offset, e.alpha, e.webkitCompassHeading, 0.05);
    alpha = e.alpha + state.ar.offset;
  }
  state.ar.lastEventAt = Date.now();

  const raw = orientationToView(alpha, e.beta, e.gamma, screenAngle());
  raw.az = (raw.az + state.ar.decl + 360) % 360; // magnetic → true north
  state.ar.view = smoothView(state.ar.view, raw, 0.25);
  state.sky = {
    az: state.ar.view.az,
    alt: Math.max(-30, Math.min(89, state.ar.view.alt)),
    fov: state.sky.fov,
    roll: state.ar.view.roll,
  };
  scheduleSkyRender();
}

function enterAR() {
  const finish = () => {
    state.ar.active = true;
    state.ar.offset = null;
    state.ar.view = null;
    state.ar.lastEventAt = 0;
    arHasAbsolute = false;
    state.ar.decl = declination(state.prefs.lat, state.prefs.lon, decimalYear(new Date()));
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    clearTimeout(arSensorTimer);
    arSensorTimer = setTimeout(() => {
      if (state.ar.active && !state.ar.lastEventAt) {
        exitAR();
        showSkyToast('No motion sensors detected');
      }
    }, 1500);
    UI.renderSky(state);
  };
  // iOS 13+: must be called synchronously inside the tap gesture
  if (typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then((res) => {
        if (res === 'granted') finish();
        else showSkyToast('Motion access denied — enable it in Settings › Safari');
      })
      .catch(() => showSkyToast('Motion access unavailable'));
  } else {
    finish();
  }
}

let camStream = null;
let camStarting = false; // re-entrancy guard: blocks a second getUserMedia while one is in flight
function stopCamera() {
  if (camStream) {
    for (const t of camStream.getTracks()) t.stop();
    camStream = null;
  }
  const video = document.getElementById('sky-camera');
  if (video) {
    video.srcObject = null;
    video.classList.add('hidden');
  }
  state.ar.camera = false;
}

async function startCamera() {
  if (camStarting || camStream) return; // already starting or already streaming
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showSkyToast('Camera not available');
    return;
  }
  camStarting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    // The user may have exited AR (or another cycle already attached a
    // stream) while this request was in flight — don't adopt an orphan.
    if (!state.ar.active || camStream) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    camStream = stream;
    const video = document.getElementById('sky-camera');
    video.srcObject = camStream;
    video.classList.remove('hidden');
    state.ar.camera = true;
  } catch {
    showSkyToast('Camera unavailable or permission denied');
    state.ar.camera = false;
  } finally {
    camStarting = false;
    UI.renderSky(state);
  }
}

function exitAR() {
  clearTimeout(arSensorTimer);
  window.removeEventListener('deviceorientationabsolute', onOrientation, true);
  window.removeEventListener('deviceorientation', onOrientation, true);
  stopCamera();
  state.ar.active = false;
  delete state.sky.roll;
  UI.renderSky(state);
}

function wireAR() {
  const btn = document.getElementById('sky-ar-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.ar.active) exitAR();
    else if (!Number.isFinite(state.prefs.lat)) showSkyToast('Waiting for location…');
    else enterAR();
  });
  document.getElementById('sky-cam-btn')?.addEventListener('click', () => {
    if (state.ar.camera) {
      stopCamera();
      UI.renderSky(state);
    } else startCamera();
  });
  // Leaving the tab or backgrounding the app ends AR (sensors + battery)
  window.addEventListener('hashchange', () => { if (state.ar.active && route !== 'sky') exitAR(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.ar.active) exitAR();
  });
}

function wireMisc() {
  // Tap any hour cell in the Forecast grid → jump Conditions to that
  // exact day + hour.
  document.getElementById('forecast-days').addEventListener('click', (e) => {
    const cell = e.target.closest('td');
    const fcDay = e.target.closest('.fc-day');
    if (!cell || !fcDay || state.status !== 'ready') return;
    const pos = cell.cellIndex - 1; // cell 0 is the sticky row label
    if (pos < 0) return;
    setDay(Number(fcDay.dataset.day));
    setHour(pos);
    location.hash = '#/';
  });

  // Forecast grid span (7 / 14 days)
  document.getElementById('fc-range').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-days]');
    if (!btn) return;
    state.forecastDays = Number(btn.dataset.days);
    document.querySelectorAll('#fc-range .seg-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    if (state.status === 'ready') UI.renderForecast(state);
  });

  // Charts range selector (24h / 3d / 7d)
  document.getElementById('chart-range').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.chartRange = Number(btn.dataset.range);
    document.querySelectorAll('#chart-range .seg-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    if (state.status === 'ready') UI.renderCharts(state);
  });

  document.getElementById('notice-close').addEventListener('click', UI.hideNotice);
  document.getElementById('retry-btn').addEventListener('click', () => {
    refetchAll({ first: true });
  });
  window.addEventListener('hashchange', applyRoute);

  // Silent refresh every 30 minutes while Conditions is visible
  setInterval(() => {
    if (document.visibilityState === 'visible' && route === 'conditions' && state.status === 'ready') {
      refetchAll({ silent: true });
    }
  }, REFRESH_MS);

  // Keep the "Updated h:mm" age readout honest as time passes.
  setInterval(() => {
    if (state.status === 'ready') UI.renderDataAge(state);
  }, 60000);
}

/* ================= Boot ================= */

async function boot() {
  try {
    await resolveLocation();
    await refetchAll({ first: true });
  } catch (err) {
    // Belt and braces: nothing above should throw, but never leave an
    // unhandled rejection or a stuck skeleton.
    console.error('Starcast boot failed:', err);
    state.status = 'error';
    UI.setLoading(false);
    UI.showView(state, route);
  }
}

function init() {
  loadPrefs();
  parseShareParams(); // ?lat/lon/name links override the stored location
  UI.applyAppearance(state); // night/CB classes before first paint
  UI.initStars();
  applyRoute(); // shell + skeleton render immediately, before any fetch
  wireTimeline();
  wireDayTabs();
  wireSwipe();
  wireShare();
  wireSettings();
  wireBreakdown();
  wireCalendarExport();
  wireSavedLocations();
  wireAppearance();
  wireMisc();
  wireSky();
  wireAR();
  boot();

  // PWA: offline shell + last-forecast caching. Registration is best-effort
  // (requires https or localhost; fails silently elsewhere). When a NEW
  // service worker takes control of an already-controlled page, a deploy
  // just landed — offer a one-tap reload instead of updating silently.
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) UI.showUpdateToast();
    });
    document.getElementById('update-reload').addEventListener('click', () => location.reload());
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}

init();
