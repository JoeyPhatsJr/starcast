// js/app.js — entry point: state, boot sequence, routing, event wiring.

import {
  fetchOpenMeteo, fetch7Timer, geocode, parseOpenMeteo,
  nearestAstro, heuristicSeeing, heuristicTransparency,
} from './weather.js';
import { sunAltitude, moonAltitude, moonIllumination, visiblePlanets, altitudeCrossings } from './astro.js';
import { overallScore } from './score.js';
import { fetchLightPollution } from './lightpollution.js';
import * as UI from './ui.js';

const PREFS_KEY = 'starcast:prefs';
const NYC = { lat: 40.7128, lon: -74.0060, name: 'New York City' };
const REFRESH_MS = 30 * 60 * 1000;

const state = {
  prefs: { lat: null, lon: null, name: '', tz: 'America/New_York', bortle: 5, bortleAuto: true, units: 'imperial' },
  hours: [],
  days: [],
  daily: [],
  selectedDay: 0,
  selectedHour: 0,
  currentHourIndex: 0,
  chartRange: 72, // hours shown on the Charts tab
  lightPollution: null, // { ratio, mpsas, bortle } from the atlas, if fetched
  status: 'loading', // loading | ready | error
};

let route = 'conditions';
let astroSeries = null; // last successful 7Timer series (survives refetches)

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
  if (typeof state.prefs.bortleAuto !== 'boolean') state.prefs.bortleAuto = true;
  if (!['imperial', 'metric'].includes(state.prefs.units)) state.prefs.units = 'imperial';
}

function savePrefs() {
  try {
    const { lat, lon, name, tz, bortle, bortleAuto, units } = state.prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lat, lon, name, tz, bortle, bortleAuto, units }));
  } catch (e) { /* private mode — prefs just won't persist */ }
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
    if (state.prefs.bortleAuto && state.prefs.bortle !== lp.bortle) {
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
    // Atlas unreachable or out of coverage — keep the current Bortle value.
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

async function resolveLocation() {
  if (Number.isFinite(state.prefs.lat) && Number.isFinite(state.prefs.lon)) return;
  try {
    Object.assign(state.prefs, await geolocate());
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

function buildDays() {
  const tz = state.prefs.tz;
  const byDate = new Map();
  state.hours.forEach((h, i) => {
    const key = UI.fmtISODate(h.time, tz);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(i);
  });
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
  rescoreAll();
  updateCurrentHour();
  buildDays();
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
}

function renderData() {
  UI.renderDayTabs(state);
  UI.renderTimelineSegments(state);
  renderSelection();
  UI.renderSettings(state);
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

  // Location-dependent, fire-and-forget: measured Bortle from the atlas.
  if (first) refreshLightPollution();

  const omPromise = fetchOpenMeteo(state.prefs.lat, state.prefs.lon, state.prefs.units);
  // 7Timer runs in parallel and NEVER blocks first paint: patch in whenever
  // (and if ever) it lands. Its failure is silently absorbed — heuristics
  // already cover seeing/transparency.
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

  const [om] = await Promise.allSettled([omPromise]);
  if (seq !== fetchSeq) return;

  if (om.status === 'fulfilled') {
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

/* ================= Routing ================= */

const ROUTES = { '': 'conditions', '#/': 'conditions', '#/forecast': 'forecast', '#/charts': 'charts', '#/settings': 'settings', '#/help': 'help' };

function applyRoute() {
  route = ROUTES[location.hash] || 'conditions';
  UI.showView(state, route);
  if (state.status === 'ready') {
    if (route === 'charts') UI.renderCharts(state);
    if (route === 'forecast') UI.renderForecast(state);
  }
}

/* ================= Interactions ================= */

function setHour(pos) {
  const day = state.days[state.selectedDay];
  if (!day) return;
  const clamped = Math.max(0, Math.min(day.hourIndices.length - 1, pos));
  if (clamped === state.selectedHour) return;
  state.selectedHour = clamped;
  renderSelection();
}

function setDay(i) {
  if (i === state.selectedDay || !state.days[i]) return;
  state.selectedDay = i;
  // Keep the same scrub hour across days (clamped to the day's length).
  state.selectedHour = Math.min(state.selectedHour, state.days[i].hourIndices.length - 1);
  UI.renderDayTabs(state);
  UI.renderTimelineSegments(state);
  renderSelection();
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

function wireShare() {
  document.getElementById('share-btn').addEventListener('click', async () => {
    const payload = {
      title: 'Starcast',
      text: 'Is it good to stargaze tonight?',
      url: location.href.split('#')[0],
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
  // Bortle chips — "Auto" measures from the atlas; a number is manual override
  document.getElementById('bortle-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.bortle === 'auto') {
      state.prefs.bortleAuto = true;
      if (state.lightPollution) {
        state.prefs.bortle = state.lightPollution.bortle;
        savePrefs();
        rescoreAll();
        renderData();
      } else {
        savePrefs();
        refreshLightPollution();
      }
      return;
    }
    state.prefs.bortleAuto = false;
    state.prefs.bortle = Number(chip.dataset.bortle);
    savePrefs();
    rescoreAll(); // pure re-score — no fetch needed
    renderData();
  });

  // Light Pollution tile → Settings, with the Bortle card flashed
  document.getElementById('tile-bortle').addEventListener('click', () => {
    location.hash = '#/settings';
    UI.flashBortleCard();
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
      UI.hideNotice();
      UI.renderSettings(state);
      astroSeries = null;
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

function wireMisc() {
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
  UI.initStars();
  applyRoute(); // shell + skeleton render immediately, before any fetch
  wireTimeline();
  wireDayTabs();
  wireShare();
  wireSettings();
  wireMisc();
  boot();
}

init();
