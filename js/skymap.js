// js/skymap.js — pure math for the Sky panorama: view state, gnomonic
// projection, and per-frame draw lists. DOM-free and Node-testable.
//
// Conventions match astro.js: degrees at the API boundary. Azimuth is
// compass azimuth (0 = N, 90 = E). The projection is gnomonic
// (rectilinear): distortion-free at center, unusable past ~110° — hence
// the FOV clamps.
//
// Gnomonic's defining property is that GREAT CIRCLES PROJECT TO STRAIGHT
// LINES. That is why the horizon (`horizonY`) is solved in closed form
// rather than sampled, and why azimuth meridians need only their endpoints.
// Only constant-altitude circles are small circles and must be sampled.
import { gmst } from './astro.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const FOV_MIN = 15;
export const FOV_MAX = 110;
export const ALT_MIN = -30; // allow dipping below horizon so it can sit high on screen
export const ALT_MAX = 89;

export const CARDINALS = [
  ['N', 0], ['NE', 45], ['E', 90], ['SE', 135],
  ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
];

export function normAz(az) {
  az %= 360;
  return az < 0 ? az + 360 : az;
}

export function clampView(v) {
  return {
    az: normAz(v.az),
    alt: Math.min(ALT_MAX, Math.max(ALT_MIN, v.alt)),
    fov: Math.min(FOV_MAX, Math.max(FOV_MIN, v.fov)),
  };
}

/** Pan by a pointer delta in px — the sky follows the finger. */
export function dragView(view, dxPx, dyPx, widthPx) {
  const s = view.fov / widthPx; // degrees per pixel at current zoom
  return clampView({ az: view.az - dxPx * s, alt: view.alt + dyPx * s, fov: view.fov });
}

/** factor > 1 zooms in (narrower field of view). */
export function zoomView(view, factor) {
  return clampView({ az: view.az, alt: view.alt, fov: view.fov / factor });
}

export function cardinalName(az) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(normAz(az) / 45) % 8];
}

/** Pixels per unit of tangent-plane offset at the current zoom. */
export function focalLength(view, w) {
  return w / 2 / Math.tan((view.fov / 2) * DEG);
}

/** (az, alt) as a unit vector in the VIEW frame: +x right, +y up, +z forward. */
function viewVec(az, alt, view) {
  const ca = Math.cos(alt * DEG);
  const x = ca * Math.sin((az - view.az) * DEG); // east-right in view frame
  const y0 = Math.sin(alt * DEG);
  const z0 = ca * Math.cos((az - view.az) * DEG);
  const cv = Math.cos(view.alt * DEG);
  const sv = Math.sin(view.alt * DEG);
  return [x, y0 * cv - z0 * sv, z0 * cv + y0 * sv];
}

/**
 * Gnomonic projection of an (az, alt) direction onto a w×h canvas for a
 * given view. Returns null when the point is behind the camera (or so far
 * off-axis the projection blows up).
 */
export function project(az, alt, view, w, h) {
  const [x, y, z] = viewVec(az, alt, view);
  if (z <= 0.05) return null;
  const f = focalLength(view, w);
  return { x: w / 2 + (x / z) * f, y: h / 2 - (y / z) * f };
}

/** Inverse of `project` — screen pixel back to a sky direction. */
export function unproject(x, y, view, w, h) {
  const f = focalLength(view, w);
  const X = (x - w / 2) / f;
  const Y = -(y - h / 2) / f;
  const cv = Math.cos(view.alt * DEG);
  const sv = Math.sin(view.alt * DEG);
  const y0 = Y * cv + sv; // un-rotate by the view altitude (Z = 1)
  const z0 = cv - Y * sv;
  const n = Math.hypot(X, y0, z0) || 1;
  return {
    az: normAz(view.az + Math.atan2(X, z0) * RAD),
    alt: Math.asin(Math.max(-1, Math.min(1, y0 / n))) * RAD,
  };
}

/**
 * Screen y of the horizon — exact, because the horizon is a great circle and
 * gnomonic sends great circles to straight lines. Everything BELOW this y is
 * ground, which is what lets the renderer fill the ground with one rect.
 * Returns null when the view is so close to the zenith that the line escapes
 * to infinity.
 */
export function horizonY(view, w, h) {
  const cv = Math.cos(view.alt * DEG);
  if (Math.abs(cv) < 1e-9) return null;
  const y = h / 2 + Math.tan(view.alt * DEG) * focalLength(view, w);
  return Number.isFinite(y) ? y : null;
}

/** Per-frame precompute so transforming ~1,600 stars stays cheap. */
export function frameContext(jd, lat, lon) {
  return { lst: gmst(jd) + lon, sinLat: Math.sin(lat * DEG), cosLat: Math.cos(lat * DEG) };
}

/** Fast equatorial→horizontal for catalog stars. Mirrors astro.horizontalOf. */
export function starHorizontal(ra, dec, fc) {
  const ha = (fc.lst - ra) * DEG;
  const sd = Math.sin(dec * DEG);
  const cd = Math.cos(dec * DEG);
  const alt = Math.asin(fc.sinLat * sd + fc.cosLat * cd * Math.cos(ha)) * RAD;
  const az = normAz(Math.atan2(Math.sin(ha), Math.cos(ha) * fc.sinLat - (sd / cd) * fc.cosLat) * RAD + 180);
  return { alt, az };
}

/* ======================= Star appearance ======================= */

// B−V colour index → RGB, from Mitchell Charity's blackbody table. The raw
// values are nearly white (which is physically honest but visually inert on a
// phone), so saturation is pushed away from the per-star mean — Betelgeuse
// reads orange and Rigel reads blue without anything looking cartoonish.
const BV_TABLE = [
  [-0.40, 155, 176, 255], [-0.30, 162, 184, 255], [-0.17, 175, 195, 255],
  [0.00, 202, 215, 255], [0.15, 228, 232, 255], [0.30, 246, 243, 255],
  [0.44, 255, 247, 252], [0.58, 255, 244, 234], [0.68, 255, 241, 223],
  [0.81, 255, 235, 209], [1.15, 255, 215, 174], [1.40, 255, 198, 144],
  [1.64, 255, 181, 108], [2.50, 255, 166, 81],
];
const SATURATION = 1.55;

/** Quantised to 0.05 in B−V so callers can cache gradients on the result. */
export function starColor(bv) {
  const v = Math.round(Math.max(-0.4, Math.min(2.5, Number(bv) || 0)) / 0.05) * 0.05;
  let i = 0;
  while (i < BV_TABLE.length - 2 && BV_TABLE[i + 1][0] < v) i++;
  const [v0, r0, g0, b0] = BV_TABLE[i];
  const [v1, r1, g1, b1] = BV_TABLE[i + 1];
  const t = v1 === v0 ? 0 : Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
  const rgb = [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const ch = rgb.map((c) => Math.round(Math.max(0, Math.min(255, mean + (c - mean) * SATURATION))));
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/**
 * Any CSS colour this app draws with → an `rgba()` string at the given alpha.
 * Star colours arrive as `rgb(...)` from starColor() but the body palettes are
 * hex; a naive string replace left hex colours fully opaque, which painted
 * every planet's halo as a solid square instead of a fading disc.
 */
export function toRgba(color, alpha) {
  const c = String(color).trim();
  if (c.startsWith('rgba(')) return c;
  if (c.startsWith('rgb(')) return `rgba(${c.slice(4, -1)},${alpha})`;
  let hex = c.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  const n = hex.length === 6 && /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : NaN;
  if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * mag −1.5 (Sirius) ≈ 4.2px, mag 5 ≈ 0.6px at the default 70° field. Zooming
 * in grows stars sub-linearly so a tight field looks detailed rather than
 * merely magnified.
 */
export function magToRadius(mag, fov = 70) {
  const base = Math.max(0.55, 3.4 - 0.55 * mag);
  const s = Math.pow(70 / (fov > 0 ? fov : 70), 0.4);
  return base * Math.min(2.2, Math.max(0.72, s));
}

/** Pickering (2002) relative air mass — finite all the way to the horizon. */
export function airmass(alt) {
  const s = Math.sin(Math.max(alt, -2) * DEG);
  return 1 / (s + 0.025 * Math.exp(-11 * s));
}

/**
 * Atmospheric extinction as a brightness multiplier (1 at the zenith). This is
 * what makes the horizon fade convincingly instead of ending in a hard line.
 * k = magnitudes lost per air mass; 0.2 is a decent clear-night value.
 */
export function extinctionFactor(alt, k = 0.2) {
  if (alt >= 89.99) return 1;
  return Math.max(0.04, Math.pow(10, -0.4 * k * (airmass(alt) - 1)));
}

/** Base opacity from magnitude alone, before extinction. */
export function magToAlpha(mag) {
  return Math.max(0.34, Math.min(1, 1.05 - 0.13 * mag));
}

/* ========================= Draw lists ========================= */

/**
 * Screen draw list for catalog stars: culls below-horizon and offscreen.
 * Catalog rows are [ra, dec, mag, bv, properName?, designation?].
 */
export function starDrawList(stars, fc, view, w, h, margin = 10) {
  const out = [];
  for (const s of stars) {
    const { alt, az } = starHorizontal(s[0], s[1], fc);
    if (alt < -0.6) continue;
    const p = project(az, alt, view, w, h);
    if (!p || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;
    out.push({
      x: p.x,
      y: p.y,
      r: magToRadius(s[2], view.fov),
      a: magToAlpha(s[2]) * extinctionFactor(alt),
      color: starColor(s[3]),
      mag: s[2],
      name: s[4] || null,
      desig: s[5] || null,
      alt,
      az,
      kind: 'star',
    });
  }
  return out;
}

/** Constellation polylines → screen point-runs, broken at horizon/behind-camera. */
export function lineDrawList(lines, fc, view, w, h) {
  const runs = [];
  for (const line of lines) {
    let run = [];
    for (const [ra, dec] of line) {
      const { alt, az } = starHorizontal(ra, dec, fc);
      const p = alt < -0.6 ? null : project(az, alt, view, w, h);
      if (p) {
        run.push(p);
      } else if (run.length) {
        if (run.length > 1) runs.push(run);
        run = [];
      }
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

// Filled regions (the Milky Way) cannot simply drop their behind-camera
// vertices the way polylines do: dropping a vertex re-closes the ring across
// the wrong side of the sky and floods the screen. They are clipped against
// the near plane FIRST, so the ring stays closed and merely runs off-screen.
const NEAR_Z = 0.02;

/** Sutherland–Hodgman clip of a view-space ring against z ≥ NEAR_Z. */
export function clipNear(pts) {
  const out = [];
  const n = pts.length;
  if (!n) return out;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const aIn = a[2] >= NEAR_Z;
    const bIn = b[2] >= NEAR_Z;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_Z - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR_Z]);
    }
  }
  return out;
}

/**
 * Closed rings (equatorial [ra, dec]) → screen polygons, near-plane clipped.
 * Coordinates are clamped to a generous box around the canvas: clipped
 * vertices sit at the horizon-at-infinity and would otherwise be ±1e9, which
 * some canvas implementations refuse to rasterise.
 */
export function polygonDrawList(rings, fc, view, w, h) {
  const f = focalLength(view, w);
  const lim = 4 * (w + h);
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const out = [];
  for (const ring of rings) {
    const vs = [];
    for (const [ra, dec] of ring) {
      const { alt, az } = starHorizontal(ra, dec, fc);
      vs.push(viewVec(az, alt, view));
    }
    const clipped = clipNear(vs);
    if (clipped.length < 3) continue;
    const poly = clipped.map(([x, y, z]) => ({
      x: cl(w / 2 + (x / z) * f, -lim, w + lim),
      y: cl(h / 2 - (y / z) * f, -lim, h + lim),
    }));
    // A ring entirely off one edge contributes nothing but fill cost.
    if (poly.every((p) => p.x < 0) || poly.every((p) => p.x > w)
        || poly.every((p) => p.y < 0) || poly.every((p) => p.y > h)) continue;
    out.push(poly);
  }
  return out;
}

/**
 * Alt/az grid: azimuth meridians every `azStep`° (straight great circles) and
 * altitude parallels every `altStep`° (small circles, so sampled).
 */
export function gridDrawList(view, w, h, azStep = 30, altStep = 30) {
  const runs = [];
  const push = (pts) => { if (pts.length > 1) runs.push(pts); };
  for (let az = 0; az < 360; az += azStep) {
    let run = [];
    for (let alt = 0; alt <= 88; alt += 4) {
      const p = project(az, alt, view, w, h);
      if (p) run.push(p);
      else { push(run); run = []; }
    }
    push(run);
  }
  for (let alt = altStep; alt < 90; alt += altStep) {
    let run = [];
    for (let az = 0; az <= 360; az += 3) {
      const p = project(az, alt, view, w, h);
      if (p) run.push(p);
      else { push(run); run = []; }
    }
    push(run);
  }
  return runs;
}

/**
 * Constellation name anchors on screen. d3-celestial's `rank` (1 = most
 * prominent) thins the list out at wide fields so a zoomed-out sky is not a
 * wall of text. Rows are [ra, dec, name, rank, abbr].
 */
export function constellationLabelList(consts, fc, view, w, h) {
  const rankLimit = view.fov > 85 ? 1 : view.fov > 55 ? 2 : 3;
  const out = [];
  for (const c of consts) {
    if ((c[3] || 3) > rankLimit) continue;
    const { alt, az } = starHorizontal(c[0], c[1], fc);
    if (alt < 2) continue;
    const p = project(az, alt, view, w, h);
    if (!p || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
    out.push({ x: p.x, y: p.y, text: c[2], abbr: c[4] || '', rank: c[3] || 3, kind: 'constellation' });
  }
  return out;
}

/**
 * Faintest star magnitude worth labelling at this zoom. Wide fields show only
 * the headline stars; zooming in progressively reveals more names.
 */
export function labelMagLimit(fov) {
  if (fov > 85) return 1.2;
  if (fov > 60) return 1.8;
  if (fov > 40) return 2.4;
  if (fov > 25) return 3.1;
  return 3.8;
}

/**
 * Greedy screen-space label placement: walk candidates in priority order and
 * keep one only if its box misses every box already kept. Callers supply real
 * measured boxes ({x, y, w, h}) so this stays free of font metrics.
 *
 * `blocked` seeds the occupied set with regions that are not labels at all —
 * the floating tool buttons and info card sit ABOVE the canvas in the DOM, so
 * anything drawn under them is invisible and must not win a slot.
 */
export function placeLabels(candidates, pad = 2, blocked = []) {
  const kept = blocked.slice();
  const placed = [];
  for (const c of candidates) {
    const clash = kept.some((k) => (
      c.x - pad < k.x + k.w + pad && c.x + c.w + pad > k.x - pad
      && c.y - pad < k.y + k.h + pad && c.y + c.h + pad > k.y - pad
    ));
    if (!clash) {
      kept.push(c);
      placed.push(c);
    }
  }
  return placed;
}

/**
 * Nearest drawn object to a screen point, for tap-to-identify. Distance is
 * measured to the object's EDGE, so a big planet beats a faint star that
 * happens to sit a pixel closer to the tap.
 */
export function pickNearest(items, x, y, maxPx = 26) {
  let best = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.max(0, Math.hypot(it.x - x, it.y - y) - (it.r || 0));
    if (d <= maxPx && d < bestD) { bestD = d; best = it; }
  }
  return best;
}

/**
 * A point `sep`° from `from` along the great circle toward `to`. Used to find
 * which way the moon's bright limb faces: it points at the sun, and taking the
 * direction from two projected points makes it automatically correct under any
 * projection distortion or AR roll.
 */
export function pointToward(from, to, sep = 2) {
  const toVec = (p) => {
    const ca = Math.cos(p.alt * DEG);
    return [ca * Math.sin(p.az * DEG), ca * Math.cos(p.az * DEG), Math.sin(p.alt * DEG)];
  };
  const a = toVec(from);
  const b = toVec(to);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let t = [b[0] - dot * a[0], b[1] - dot * a[1], b[2] - dot * a[2]]; // tangent at `a`
  const tn = Math.hypot(t[0], t[1], t[2]);
  if (tn < 1e-9) return { az: from.az, alt: from.alt }; // coincident or antipodal
  t = [t[0] / tn, t[1] / tn, t[2] / tn];
  const c = Math.cos(sep * DEG);
  const s = Math.sin(sep * DEG);
  const v = [a[0] * c + t[0] * s, a[1] * c + t[1] * s, a[2] * c + t[2] * s];
  return {
    az: normAz(Math.atan2(v[0], v[1]) * RAD),
    alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD,
  };
}
