// js/astro.js — client-side ephemeris (low-precision, Meeus-style).
//
// Accuracy target here is coarse (roughly ±1°): this powers a stargazing
// dashboard, not an almanac. All series are truncated to their dominant
// terms, which is plenty to answer "is the moon up?" / "is Jupiter up?".
//
// Conventions: angles in DEGREES at the API boundary, converted to radians
// only inside trig calls. Longitudes are east-positive. Altitudes ignore
// atmospheric refraction (~0.5° at the horizon — inside our error budget).

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const sin = (d) => Math.sin(d * DEG);
const cos = (d) => Math.cos(d * DEG);

function norm360(x) {
  x %= 360;
  return x < 0 ? x + 360 : x;
}

function norm180(x) {
  return norm360(x + 180) - 180;
}

/** Julian date from a JS Date (which is inherently UTC-based). */
export function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Greenwich Mean Sidereal Time in degrees (includes the day fraction). */
export function gmst(jd) {
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0));
}

/** Mean obliquity of the ecliptic, degrees. */
function obliquity(jd) {
  const T = (jd - 2451545.0) / 36525;
  return 23.43929111 - 0.0130042 * T;
}

/** Ecliptic (λ, β) in degrees → equatorial { ra, dec } in degrees. */
function eclToEq(lam, bet, jd) {
  const e = obliquity(jd);
  const ra = Math.atan2(sin(lam) * cos(e) - Math.tan(bet * DEG) * sin(e), cos(lam)) * RAD;
  const dec = Math.asin(sin(bet) * cos(e) + cos(bet) * sin(e) * sin(lam)) * RAD;
  return { ra: norm360(ra), dec };
}

/** Altitude (degrees) of a body at (ra, dec) for an observer at lat/lon. */
export function altitudeOf(ra, dec, jd, lat, lon) {
  return horizontalOf(ra, dec, jd, lat, lon).alt;
}

/**
 * Horizontal coordinates of a body at (ra, dec): altitude plus compass
 * azimuth (0 = north, 90 = east). Azimuth comes from the standard
 * meridian-relative form, then is rotated 180° to compass convention.
 */
export function horizontalOf(ra, dec, jd, lat, lon) {
  const lst = gmst(jd) + lon; // local sidereal time, east longitude positive
  const ha = norm360(lst - ra); // hour angle
  const alt = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha)) * RAD;
  const az = norm360(
    Math.atan2(sin(ha), cos(ha) * sin(lat) - Math.tan(dec * DEG) * cos(lat)) * RAD + 180
  );
  return { alt, az };
}

/** Apparent ecliptic longitude of the Sun, degrees (Meeus ch. 25, truncated). */
function sunEclipticLongitude(jd) {
  const T = (jd - 2451545.0) / 36525;
  const L0 = norm360(280.46646 + 36000.76983 * T); // geometric mean longitude
  const M = norm360(357.52911 + 35999.05029 * T); // mean anomaly
  const C = // equation of center
    (1.914602 - 0.004817 * T) * sin(M) +
    (0.019993 - 0.000101 * T) * sin(2 * M) +
    0.000289 * sin(3 * M);
  return norm360(L0 + C);
}

/** Solar altitude in degrees for a Date + observer. Drives darkness scoring. */
export function sunAltitude(date, lat, lon) {
  const jd = julianDate(date);
  const { ra, dec } = eclToEq(sunEclipticLongitude(jd), 0, jd);
  return altitudeOf(ra, dec, jd, lat, lon);
}

/**
 * Low-precision lunar ecliptic position: mean longitude plus the single
 * dominant elliptic term (6.289° · sin M), and the dominant latitude term.
 * Good to ~1° — fine for "is the moon up" and phase work.
 */
function moonEcliptic(jd) {
  const d = jd - 2451545.0;
  const L = norm360(218.316 + 13.176396 * d); // mean longitude
  const M = norm360(134.963 + 13.064993 * d); // mean anomaly
  const F = norm360(93.272 + 13.229350 * d); // argument of latitude
  return {
    lam: norm360(L + 6.289 * sin(M)),
    bet: 5.128 * sin(F),
  };
}

/**
 * Lunar altitude in degrees for a Date + observer, with the topocentric
 * parallax correction (−HP·cos alt, HP ≈ 0.952° at mean distance) — the
 * moon is close enough that the observer's position on Earth shifts it by
 * up to a degree, which moves rise/set times by ~10 minutes.
 */
export function moonAltitude(date, lat, lon) {
  const jd = julianDate(date);
  const { lam, bet } = moonEcliptic(jd);
  const { ra, dec } = eclToEq(lam, bet, jd);
  const geo = altitudeOf(ra, dec, jd, lat, lon);
  return geo - 0.952 * cos(geo);
}

/**
 * Moon illumination from the sun–moon elongation in ecliptic longitude.
 * fraction: 0 (new) → 1 (full). waxing: true while elongation < 180°.
 */
export function moonIllumination(date) {
  const jd = julianDate(date);
  const { lam } = moonEcliptic(jd);
  const elong = norm360(lam - sunEclipticLongitude(jd));
  return {
    fraction: (1 - cos(elong)) / 2,
    waxing: elong < 180,
  };
}

/**
 * Upcoming new and full moons within `days` of `startDate`, by scanning the
 * sun–moon elongation for 0°/180° crossings (hourly scan + bisection to
 * ~1 minute). Returns [{ type: 'new'|'full', time }] in chronological order.
 */
export function nextLunations(startDate, days = 45) {
  const elong = (ms) => {
    const jd = julianDate(new Date(ms));
    const { lam } = moonEcliptic(jd);
    return norm360(lam - sunEclipticLongitude(jd));
  };
  const out = [];
  const step = 3600000;
  const startMs = startDate.getTime();
  let prev = elong(startMs);
  for (let t = startMs + step; t <= startMs + days * 86400000; t += step) {
    const cur = elong(t);
    // New moon: elongation wraps 360→0. Full moon: crosses 180 rising.
    const wrapped = cur < prev; // decreasing means we passed 0 (elongation only grows ~0.5°/h)
    const crossedFull = prev < 180 && cur >= 180;
    if (wrapped || crossedFull) {
      const target = wrapped ? 0 : 180;
      let lo = t - step;
      let hi = t;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const e = elong(mid);
        const passed = wrapped ? e < prev && e < 90 : e >= target;
        if (passed) hi = mid;
        else lo = mid;
      }
      out.push({ type: wrapped ? 'new' : 'full', time: (lo + hi) / 2 });
    }
    prev = cur;
  }
  return out;
}

/**
 * Find the times inside [startMs, endMs] where an altitude function crosses
 * `threshold` degrees. Scans in `stepMinutes` strides, then bisects each
 * bracket down to ~½-minute precision. Returns [{ time, rising }] in order.
 * Used for moonrise/moonset (threshold 0) and astronomical-darkness bounds
 * (sun crossing −18°).
 */
export function altitudeCrossings(altFn, startMs, endMs, threshold = 0, stepMinutes = 10) {
  const out = [];
  const step = stepMinutes * 60000;
  let prevBelow = altFn(new Date(startMs)) < threshold;
  for (let t = startMs + step; t <= endMs; t += step) {
    const below = altFn(new Date(t)) < threshold;
    if (below !== prevBelow) {
      let lo = t - step;
      let hi = t;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        if ((altFn(new Date(mid)) < threshold) === prevBelow) lo = mid;
        else hi = mid;
      }
      out.push({ time: (lo + hi) / 2, rising: prevBelow });
    }
    prevBelow = below;
  }
  return out;
}

/*
 * Planets — mean Keplerian elements at J2000 with linear rates per Julian
 * century (standard JPL "approximate positions" table). Element order:
 * [a (au), e, I (deg), L (deg), ϖ (deg, long. of perihelion), Ω (deg)].
 */
const EARTH = {
  el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
  rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
};

const PLANETS = [
  {
    abbr: 'Me',
    name: 'Mercury',
    el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  {
    abbr: 'V',
    name: 'Venus',
    el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  },
  {
    abbr: 'Ma',
    name: 'Mars',
    el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  {
    abbr: 'J',
    name: 'Jupiter',
    el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  {
    abbr: 'S',
    name: 'Saturn',
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
];

/**
 * Heliocentric ecliptic rectangular coordinates (au) from mean elements.
 * Solves Kepler's equation with 5 Newton iterations (converges fast for
 * every planet's eccentricity).
 */
function heliocentric(body, T) {
  const [a, e, I, L, peri, node] = body.el.map((v, i) => v + body.rate[i] * T);
  const M = norm180(L - peri); // mean anomaly
  const eDeg = e * RAD; // eccentricity expressed in degrees for the solver

  let E = M + eDeg * sin(M); // eccentric anomaly, first guess
  for (let i = 0; i < 5; i++) {
    const dM = M - (E - eDeg * sin(E));
    E += dM / (1 - e * cos(E));
  }

  // Position in the orbital plane
  const xp = a * (cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * sin(E);

  // Rotate: argument of perihelion ω = ϖ − Ω, then inclination, then node
  const w = peri - node;
  const x =
    (cos(w) * cos(node) - sin(w) * sin(node) * cos(I)) * xp +
    (-sin(w) * cos(node) - cos(w) * sin(node) * cos(I)) * yp;
  const y =
    (cos(w) * sin(node) + sin(w) * cos(node) * cos(I)) * xp +
    (-sin(w) * sin(node) + cos(w) * cos(node) * cos(I)) * yp;
  const z = sin(w) * sin(I) * xp + cos(w) * sin(I) * yp;
  return { x, y, z };
}

/** Altitude in degrees of one planet (by table index) at an instant. */
function planetAltitude(index, date, lat, lon) {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525;
  const earth = heliocentric(EARTH, T);
  const p = heliocentric(PLANETS[index], T);
  const x = p.x - earth.x;
  const y = p.y - earth.y;
  const z = p.z - earth.z;
  const lam = Math.atan2(y, x) * RAD;
  const bet = Math.atan2(z, Math.hypot(x, y)) * RAD;
  const { ra, dec } = eclToEq(lam, bet, jd);
  return altitudeOf(ra, dec, jd, lat, lon);
}

/**
 * Abbreviations of planets more than `minAlt` degrees above the horizon
 * at the given instant, in Me/V/Ma/J/S order.
 */
export function visiblePlanets(date, lat, lon, minAlt = 5) {
  const out = [];
  for (let i = 0; i < PLANETS.length; i++) {
    if (planetAltitude(i, date, lat, lon) > minAlt) out.push(PLANETS[i].abbr);
  }
  return out;
}

/**
 * Per-planet events across a window (typically one night): rise/set through
 * `minAlt`, plus the peak altitude and its time (20-minute sampling — this
 * is planning info, not an almanac). Only returns planets that clear
 * `minAlt` at some point. Sorted by peak altitude, best first.
 */
export function planetNightEvents(startMs, endMs, lat, lon, minAlt = 5) {
  const out = [];
  for (let i = 0; i < PLANETS.length; i++) {
    const altAt = (d) => planetAltitude(i, d, lat, lon);
    let peakAlt = -90;
    let peakTime = startMs;
    for (let t = startMs; t <= endMs; t += 20 * 60000) {
      const a = altAt(new Date(t));
      if (a > peakAlt) { peakAlt = a; peakTime = t; }
    }
    if (peakAlt <= minAlt) continue;
    const crossings = altitudeCrossings(altAt, startMs, endMs, minAlt, 20);
    const riseX = crossings.find((c) => c.rising);
    const setX = crossings.find((c) => !c.rising);
    out.push({
      abbr: PLANETS[i].abbr,
      name: PLANETS[i].name,
      rise: riseX ? riseX.time : null, // null → already up at window start
      set: setX ? setX.time : null, // null → still up at window end
      peakAlt,
      peakTime,
    });
  }
  return out.sort((a, b) => b.peakAlt - a.peakAlt);
}
