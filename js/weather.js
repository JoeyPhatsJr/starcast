// js/weather.js — Open-Meteo + 7Timer fetch/parse. No DOM access.

const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OM_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const SEVENTIMER = 'https://www.7timer.info/bin/astro.php';

const HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'dew_point_2m',
  'relative_humidity_2m',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'precipitation_probability',
  'visibility',
  'wind_speed_10m',
  'weather_code',
  'is_day',
].join(',');

const MILE = 1609.34; // meters per mile
const KMH_PER_MPH = 1.609344;

/**
 * Fetch the 14-day hourly forecast. `timeformat=unixtime` gives true UTC
 * epochs for every hour — the ephemeris math needs real instants, and the
 * response's `timezone` field (IANA string) drives all display formatting.
 */
export async function fetchOpenMeteo(lat, lon, units) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: HOURLY_VARS,
    daily: 'sunrise,sunset',
    forecast_days: '14',
    timezone: 'auto',
    timeformat: 'unixtime',
    temperature_unit: units === 'metric' ? 'celsius' : 'fahrenheit',
    wind_speed_unit: units === 'metric' ? 'kmh' : 'mph',
  });
  const res = await fetch(`${OM_FORECAST}?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

/** Null-safe array read with a fallback for the rare gaps at range edges. */
function num(arr, i, fallback) {
  const v = arr ? arr[i] : null;
  return v == null || Number.isNaN(v) ? fallback : v;
}

/**
 * Flatten the Open-Meteo response into per-hour records. Each record keeps
 * display-unit values (whatever was fetched) AND canonical scoring values
 * (windMph / apparentF / visMiles) so score.js thresholds never care about
 * the user's unit preference.
 */
export function parseOpenMeteo(data, units) {
  const metric = units === 'metric';
  const h = data.hourly;

  const hours = h.time.map((t, i) => {
    const wind = num(h.wind_speed_10m, i, 0);
    const apparent = num(h.apparent_temperature, i, metric ? 10 : 50);
    const visM = num(h.visibility, i, 10000); // meters
    return {
      time: t * 1000, // epoch ms (UTC instant)
      temp: num(h.temperature_2m, i, metric ? 10 : 50),
      apparent,
      dewPoint: num(h.dew_point_2m, i, metric ? 5 : 40),
      humidity: num(h.relative_humidity_2m, i, 50),
      cloud: num(h.cloud_cover, i, 0),
      cloudLow: num(h.cloud_cover_low, i, 0),
      cloudMid: num(h.cloud_cover_mid, i, 0),
      cloudHigh: num(h.cloud_cover_high, i, 0),
      precipProb: num(h.precipitation_probability, i, 0),
      visibility: metric ? visM / 1000 : visM / MILE, // display unit
      wind, // display unit (mph or km/h)
      weatherCode: num(h.weather_code, i, 3),
      isDay: num(h.is_day, i, 0),
      // Canonical values for scoring:
      windMph: metric ? wind / KMH_PER_MPH : wind,
      apparentF: metric ? apparent * 9 / 5 + 32 : apparent,
      visMiles: visM / MILE,
      // Filled in later by app.js (astro + seeing/transparency + score):
      sunAlt: 0,
      moonAlt: 0,
      moonIllum: 0,
      moonWaxing: true,
      planets: [],
      seeing: 0.5,
      transparency: 0.5,
      seeingIsEstimate: true,
      score: 0,
    };
  });

  const daily = (data.daily?.time || []).map((t, i) => ({
    date: t * 1000, // epoch of local midnight
    sunrise: data.daily.sunrise?.[i] != null ? data.daily.sunrise[i] * 1000 : null,
    sunset: data.daily.sunset?.[i] != null ? data.daily.sunset[i] * 1000 : null,
  }));

  return { tz: data.timezone, hours, daily };
}

/**
 * Fetch 7Timer ASTRO seeing/transparency. Both arrive as 1–8 (1 best) in
 * 3-hour steps covering ~72h; we remap to a 0–1 "higher is better" scale.
 * 7Timer is slow and flaky, so: 8-second AbortController timeout, and the
 * caller must treat rejection as non-fatal (heuristics cover the gap).
 */
export async function fetch7Timer(lat, lon) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = `${SEVENTIMER}?lon=${lon.toFixed(3)}&lat=${lat.toFixed(3)}&ac=0&unit=metric&output=json`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`7Timer HTTP ${res.status}`);
    const data = await res.json();

    // init is "YYYYMMDDHH" in UTC; timepoint is hours after init.
    const s = String(data.init);
    const base = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10));
    return (data.dataseries || []).map((d) => ({
      time: base + d.timepoint * 3600000,
      seeing: (8 - d.seeing) / 7,
      transparency: (8 - d.transparency) / 7,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Nearest 7Timer point to an epoch, or null when the hour falls outside
 * the series' ~72h coverage (points are 3h apart, so anything > 2h away
 * means we're off the end).
 */
export function nearestAstro(series, epochMs, maxGapMs = 2 * 3600000) {
  if (!series || !series.length) return null;
  let bestPoint = null;
  let bestGap = Infinity;
  for (const p of series) {
    const gap = Math.abs(p.time - epochMs);
    if (gap < bestGap) {
      bestGap = gap;
      bestPoint = p;
    }
  }
  return bestGap <= maxGapMs ? bestPoint : null;
}

/** Heuristic seeing when 7Timer is unavailable or out of range. */
export function heuristicSeeing(hour) {
  return Math.max(0, Math.min(1, 1 - hour.cloud / 100 - hour.windMph / 60));
}

/** Heuristic transparency when 7Timer is unavailable or out of range. */
export function heuristicTransparency(hour) {
  return Math.max(0, Math.min(1, 1 - hour.humidity / 120 - hour.cloudHigh / 150));
}

/** City search via Open-Meteo's geocoder. Returns up to 5 candidates. */
export async function geocode(query) {
  const params = new URLSearchParams({
    name: query,
    count: '5',
    language: 'en',
    format: 'json',
  });
  const res = await fetch(`${OM_GEOCODE}?${params}`);
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    lat: r.latitude,
    lon: r.longitude,
  }));
}
