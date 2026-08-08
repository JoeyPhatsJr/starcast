// js/skymap.js — pure math for the Sky panorama: view state, gnomonic
// projection, and per-frame draw lists. DOM-free and Node-testable.
//
// Conventions match astro.js: degrees at the API boundary. Azimuth is
// compass azimuth (0 = N, 90 = E). The projection is gnomonic
// (rectilinear): distortion-free at center, unusable past ~110° — hence
// the FOV clamps.
import { gmst } from './astro.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const FOV_MIN = 30;
export const FOV_MAX = 100;
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

/**
 * Gnomonic projection of an (az, alt) direction onto a w×h canvas for a
 * given view. Returns null when the point is behind the camera (or so far
 * off-axis the projection blows up).
 */
export function project(az, alt, view, w, h) {
  const ca = Math.cos(alt * DEG);
  const x = ca * Math.sin((az - view.az) * DEG); // east-right in view frame
  const y0 = Math.sin(alt * DEG);
  const z0 = ca * Math.cos((az - view.az) * DEG);
  const cv = Math.cos(view.alt * DEG);
  const sv = Math.sin(view.alt * DEG);
  const y = y0 * cv - z0 * sv; // rotate down by the view altitude
  const z = z0 * cv + y0 * sv; // forward component
  if (z <= 0.05) return null;
  const f = w / 2 / Math.tan((view.fov / 2) * DEG);
  return { x: w / 2 + (x / z) * f, y: h / 2 - (y / z) * f };
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

/** mag −1.5 (Sirius) ≈ 4.2px, mag 5 ≈ 0.65px. */
export function magToRadius(mag) {
  return Math.max(0.6, 3.4 - 0.55 * mag);
}

/** Screen draw list for catalog stars: culls below-horizon and offscreen. */
export function starDrawList(stars, fc, view, w, h, margin = 10) {
  const out = [];
  for (const s of stars) {
    const { alt, az } = starHorizontal(s[0], s[1], fc);
    if (alt < -0.5) continue;
    const p = project(az, alt, view, w, h);
    if (!p || p.x < -margin || p.x > w + margin || p.y < -margin || p.y > h + margin) continue;
    out.push({ x: p.x, y: p.y, r: magToRadius(s[2]), name: s[3] || null });
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
      const p = alt < -0.5 ? null : project(az, alt, view, w, h);
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

/** The alt=0 circle as screen point-runs (sampled every 2° of azimuth). */
export function horizonDrawList(view, w, h) {
  const runs = [];
  let run = [];
  for (let az = 0; az <= 360; az += 2) {
    const p = project(az, 0, view, w, h);
    if (p) {
      run.push(p);
    } else if (run.length) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
