// js/score.js — per-metric scoring + overall verdict. Pure functions, no DOM.
//
// Every metric maps to [0, 1]. Rating bands used everywhere in the UI:
//   score ≥ 0.66 → "good" (green), 0.33–0.66 → "marginal" (olive), < 0.33 → "bad" (red)

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Piecewise-linear ramp: returns 1.0 at `best`, 0.0 at `worst`, linear
 * in between, clamped outside. Works in either direction (best < worst
 * or best > worst).
 */
function ramp(value, best, worst) {
  if (value == null || Number.isNaN(value)) return 0.5;
  if (best === worst) return value === best ? 1 : 0;
  return clamp01((value - worst) / (best - worst));
}

/**
 * Score a single metric. `ctx` carries astronomical context:
 * { bortle, moonAltitude, sunAltitude, moonIllum }.
 */
export function scoreMetric(name, value, ctx = {}) {
  switch (name) {
    case 'cloud': // % cover: 0% → 1.0, ≥80% → 0.0
      return ramp(value, 0, 80);
    case 'precip': // % probability: 0% → 1.0, ≥60% → 0.0
      return ramp(value, 0, 60);
    case 'wind': // mph: ≤5 → 1.0, ≥25 → 0.0
      return ramp(value, 5, 25);
    case 'visibility': // miles: ≥10 → 1.0, ≤2 → 0.0
      return ramp(value, 10, 2);
    case 'seeing': // already a 0–1 score
    case 'transparency':
      return clamp01(value ?? 0.5);
    case 'moon': // perfect when below horizon, else 1 − illuminated fraction
      return ctx.moonAltitude < 0 ? 1 : clamp01(1 - (ctx.moonIllum ?? 0.5));
    case 'lightPollution': // Bortle: ≤2 → 1.0, ≥8 → 0.0
      return ramp(value, 2, 8);
    case 'darkness': // sun altitude: ≤ −18° (astro dark) → 1.0, ≥ 0° → 0.0
      return ramp(ctx.sunAltitude, -18, 0);
    case 'windChill': { // °F comfort band: 32–75 → 1.0, ≤0 or ≥100 → 0.0
      if (value == null) return 0.5;
      if (value >= 32 && value <= 75) return 1;
      return value < 32 ? ramp(value, 32, 0) : ramp(value, 75, 100);
    }
    case 'weatherCode': { // WMO code buckets
      if (value === 0 || value === 1) return 1.0;
      if (value === 2) return 0.6;
      if (value === 3) return 0.2;
      return 0.0; // fog / drizzle / rain / snow / storms (≥ 45)
    }
    case 'sunTimes': // informational — always neutral olive
      return 0.5;
    default:
      return 0.5;
  }
}

/** Weights for the overall blend — sums to 1.00. */
export const WEIGHTS = {
  cloud: 0.30,
  darkness: 0.20,
  precip: 0.12,
  moon: 0.10,
  transparency: 0.08,
  seeing: 0.06,
  wind: 0.05,
  visibility: 0.04,
  lightPollution: 0.03,
  windChill: 0.02,
};

/**
 * Overall stargazing score for one hour record. Expects canonical-unit
 * fields on the record (windMph, apparentF, visMiles) so the thresholds
 * above are unit-independent. Hard overrides applied after the blend.
 */
export function overallScore(hour, ctx) {
  const parts = {
    cloud: scoreMetric('cloud', hour.cloud),
    darkness: scoreMetric('darkness', null, ctx),
    precip: scoreMetric('precip', hour.precipProb),
    moon: scoreMetric('moon', null, ctx),
    transparency: scoreMetric('transparency', hour.transparency),
    seeing: scoreMetric('seeing', hour.seeing),
    wind: scoreMetric('wind', hour.windMph),
    visibility: scoreMetric('visibility', hour.visMiles),
    lightPollution: scoreMetric('lightPollution', ctx.bortle),
    windChill: scoreMetric('windChill', hour.apparentF),
  };

  let total = 0;
  for (const key in WEIGHTS) total += WEIGHTS[key] * parts[key];

  // Hard overrides — never "good" in daylight, under overcast, or in rain.
  if (ctx.sunAltitude > 0) total = Math.min(total, 0.25);
  if (hour.cloud >= 90) total = Math.min(total, 0.20);
  if (hour.precipProb >= 70) total = Math.min(total, 0.25);

  return clamp01(total);
}

/** Verdict text for the banner. */
export function verdict(score) {
  if (score >= 0.66) return 'Good To Stargaze';
  if (score >= 0.33) return 'Marginal Stargazing';
  return 'Not Good To Stargaze';
}

/** Rating band name — maps directly to CSS classes band-good/-marginal/-bad. */
export function band(score) {
  if (score >= 0.66) return 'good';
  if (score >= 0.33) return 'marginal';
  return 'bad';
}
