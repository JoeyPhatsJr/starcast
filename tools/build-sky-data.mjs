// tools/build-sky-data.mjs — regenerate data/sky.json. Dev-only; run once and
// check the output in. Usage:
//   node tools/build-sky-data.mjs [path/to/local/hygdata.csv]
// Sources:
//   Stars: HYG v4.1 (astronexus.com) — CC BY-SA 4.0. `ra` column is in HOURS.
//   Lines/names/Milky Way: d3-celestial by Olaf Frohn — BSD-3. GeoJSON, RA in
//   degrees (−180..180 in the source, normalized to 0..360 here).
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const HYG_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';
const LINES_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json';
const CONST_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json';
const MW_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/mw.json';
const MAG_LIMIT = 5.0;
const NAME_MAG_LIMIT = 2.6; // proper names kept this bright and brighter
const ALWAYS_NAME = new Set(['Polaris']); // dimmer than the cutoff, but iconic
// Milky Way outlines are a soft glow — 0.6° of detail is far more than a
// phone screen resolves, and it keeps the payload to a few KB per level.
const MW_TOLERANCE_DEG = 0.6;
const MW_MIN_RING_PTS = 8;

/** HYG spells Bayer letters as 3-letter codes, sometimes with a superscript
 *  index ("Alp1" = α¹). Rendered as real Greek so labels read like a chart. */
const GREEK = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ',
  Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π',
  Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};
const SUPER = { 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵' };

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Wrap to [0, 360) at the OUTPUT precision. Rounding after the wrap is what
 *  matters: 359.97 rounded to 1dp is 360.0, which is out of range again, so
 *  the wrap has to happen at the same number of digits the file will carry. */
function normRa(deg, digits = 2) {
  let ra = +(((deg % 360) + 360) % 360).toFixed(digits);
  if (ra >= 360) ra = 0;
  return ra;
}

/* ============================ Stars ============================ */

const csv = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(HYG_URL)).text();
const rows = csv.split('\n');
const col = Object.fromEntries(splitCsvLine(rows[0]).map((h, i) => [h.trim(), i]));

const stars = [];
for (let i = 1; i < rows.length; i++) {
  const f = splitCsvLine(rows[i]);
  if (f.length < 15 || f[col.id] === '0') continue; // short row or Sol
  const mag = parseFloat(f[col.mag]);
  const raHours = parseFloat(f[col.ra]);
  const dec = parseFloat(f[col.dec]);
  if (!Number.isFinite(mag) || mag > MAG_LIMIT) continue;
  if (!Number.isFinite(raHours) || !Number.isFinite(dec)) continue;

  // B−V colour index drives the rendered star colour. Missing values default
  // to 0.0 (an A0 star — white), the neutral choice.
  const bv = parseFloat(f[col.ci]);
  const star = [
    normRa(raHours * 15),
    +dec.toFixed(2),
    +mag.toFixed(1),
    Number.isFinite(bv) ? +Math.max(-0.4, Math.min(2.5, bv)).toFixed(2) : 0,
  ];

  const proper = (f[col.proper] || '').trim();
  const con = (f[col.con] || '').trim();
  const bayerRaw = (f[col.bayer] || '').trim();
  const flam = (f[col.flam] || '').trim();
  let desig = '';
  if (con) {
    const m = /^([A-Za-z]+)(\d?)$/.exec(bayerRaw);
    if (m && GREEK[m[1]]) desig = GREEK[m[1]] + (SUPER[m[2]] || '') + ' ' + con;
    else if (flam) desig = flam + ' ' + con;
  }
  // Index 4 = proper name (0 when absent), index 5 = Bayer/Flamsteed
  // designation. Both are optional and trailing slots are trimmed, so a star
  // with neither stays a 4-element row.
  const named = proper && (mag <= NAME_MAG_LIMIT || ALWAYS_NAME.has(proper));
  if (named || desig) star.push(named ? proper : 0);
  if (desig) star.push(desig);
  stars.push(star);
}
stars.sort((a, b) => a[2] - b[2]); // brightest first → draw/label priority

// Drop proper-name labels within 0.1° of an already-labeled brighter star —
// α Cen A/B ("Rigil Kentaurus" + "Toliman") otherwise label twice at one spot.
// 0.1° keeps legitimately close pairs like Mizar/Alcor (0.197° apart).
const labeled = [];
for (const s of stars) {
  if (!s[4]) continue;
  const cosD = Math.cos((s[1] * Math.PI) / 180);
  const clash = labeled.some(([ra, dec]) => {
    let dRa = Math.abs(s[0] - ra);
    if (dRa > 180) dRa = 360 - dRa;
    return Math.hypot(dRa * cosD, s[1] - dec) <= 0.1;
  });
  if (clash) s[4] = 0; // demote to its Bayer designation (or nothing)
  else labeled.push([s[0], s[1]]);
}
for (const s of stars) if (s.length === 5 && !s[4]) s.length = 4; // trim "0" tails

/* ====================== Constellation figures ====================== */

const geo = await (await fetch(LINES_URL)).json();
const lines = [];
for (const feat of geo.features) {
  for (const seg of feat.geometry.coordinates) {
    lines.push(seg.map(([lon, lat]) => [normRa(lon, 1), +lat.toFixed(1)]));
  }
}

// Label anchors: d3-celestial ships a Point per constellation plus a `rank`
// (1 = most prominent) used to thin labels out when the view is zoomed out.
// The IAU abbreviation is what star designations end with ("α CMa"), so it is
// the join key that lets a tapped star name its constellation.
const cgeo = await (await fetch(CONST_URL)).json();
const consts = cgeo.features.map((f) => [
  normRa(f.geometry.coordinates[0], 1),
  +f.geometry.coordinates[1].toFixed(1),
  f.properties.name,
  Number(f.properties.rank) || 3,
  f.properties.desig,
]);

/* =========================== Milky Way =========================== */

/** Perpendicular distance of p from segment a→b, in plain 2-D degrees. Good
 *  enough for simplification: the outlines never approach the poles. */
function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Iterative Douglas–Peucker (recursion would blow the stack on 12k points). */
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(pts[i], pts[lo], pts[hi]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([lo, best], [best, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const mwGeo = await (await fetch(MW_URL)).json();
// Levels are nested brightness contours ol1 (faintest) → ol5 (brightest);
// stacking them translucently reproduces the glow gradient for free.
const mw = [];
for (const id of ['ol1', 'ol2', 'ol3', 'ol4', 'ol5']) {
  const feat = mwGeo.features.find((f) => f.id === id);
  if (!feat) continue;
  const rings = [];
  for (const poly of feat.geometry.coordinates) {
    for (const ring of poly) {
      // Un-wrap RA before simplifying: a ring that straddles RA 0 would
      // otherwise have a 360° jump that Douglas–Peucker treats as real detail.
      const un = [];
      let prev = null;
      for (const [lon, lat] of ring) {
        let ra = ((lon % 360) + 360) % 360;
        if (prev !== null) ra += 360 * Math.round((prev - ra) / 360);
        un.push([ra, lat]);
        prev = ra;
      }
      const s = simplify(un, MW_TOLERANCE_DEG);
      if (s.length < MW_MIN_RING_PTS) continue;
      rings.push(s.map(([ra, lat]) => [normRa(ra, 1), +lat.toFixed(1)]));
    }
  }
  if (rings.length) mw.push(rings);
}

/* ============================= Write ============================= */

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const out = { stars, lines, consts, mw };
writeFileSync(new URL('../data/sky.json', import.meta.url), JSON.stringify(out));
const mwPts = mw.reduce((a, lv) => a + lv.reduce((b, r) => b + r.length, 0), 0);
console.log(
  `data/sky.json: ${stars.length} stars (${stars.filter((s) => s[4]).length} proper-named, `
  + `${stars.filter((s) => s[5]).length} designated), ${lines.length} polylines, `
  + `${consts.length} constellation labels, ${mw.length} Milky Way levels / ${mwPts} points`
);
