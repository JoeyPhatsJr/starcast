// tools/build-sky-data.mjs — regenerate data/sky.json. Dev-only; run once and
// check the output in. Usage:
//   node tools/build-sky-data.mjs [path/to/local/hygdata.csv]
// Sources:
//   Stars: HYG v4.1 (astronexus.com) — CC BY-SA 4.0. `ra` column is in HOURS.
//   Lines: d3-celestial by Olaf Frohn — BSD-3. GeoJSON, RA degrees in -180..180.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const HYG_URL = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';
const LINES_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json';
const BORDERS_URL = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.borders.json';
const MAG_LIMIT = 5.0;
const NAME_MAG_LIMIT = 1.6;
const ALWAYS_NAME = new Set(['Polaris']); // dimmer than the cutoff, but iconic

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
  const star = [+(raHours * 15).toFixed(2), +dec.toFixed(2), +mag.toFixed(1)];
  const proper = (f[col.proper] || '').trim();
  if (proper && (mag <= NAME_MAG_LIMIT || ALWAYS_NAME.has(proper))) star.push(proper);
  stars.push(star);
}
stars.sort((a, b) => a[2] - b[2]); // brightest first → draw/label priority

const lines = [];
for (const geo of [
  await (await fetch(LINES_URL)).json(),
  await (await fetch(BORDERS_URL)).json()
]) {
  for (const feat of geo.features) {
    if (feat.geometry.type === 'MultiLineString') {
      for (const seg of feat.geometry.coordinates) {
        lines.push(seg.map(([lon, lat]) => {
          let ra = +(((lon % 360) + 360) % 360).toFixed(1);
          if (ra === 360) ra = 0;
          return [ra, +lat.toFixed(1)];
        }));
      }
    } else if (feat.geometry.type === 'LineString') {
      lines.push(feat.geometry.coordinates.map(([lon, lat]) => {
        let ra = +(((lon % 360) + 360) % 360).toFixed(1);
        if (ra === 360) ra = 0;
        return [ra, +lat.toFixed(1)];
      }));
    }
  }
}

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/sky.json', import.meta.url), JSON.stringify({ stars, lines }));
console.log(`data/sky.json: ${stars.length} stars (${stars.filter((s) => s[3]).length} named), ${lines.length} polylines`);
