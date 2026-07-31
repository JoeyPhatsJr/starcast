// js/lightpollution.js — live zenith-brightness lookup from David Lorenz's
// World Atlas 2024 (djlorenz.github.io), served as static gzip tiles on
// GitHub Pages (CORS-open, keyless). Each 5°×5° tile is a 600×600 grid of
// first-difference-encoded Int8 values at 1/120° resolution.
//
// Decoding scheme (from the atlas's own map viewer):
//   value(0,0) = 128*b[0] + b[1]  (two bytes)
//   moving up a row adds b[600*i + 1]; moving right adds b[600*(iy-1)+1+i]
//   artificial/natural brightness ratio = (5/195)·(e^(0.0195·v) − 1)
//   zenith sky brightness = 22.0 − 5·log(1+ratio)/log(100)  [mag/arcsec²]
//
// Bortle class here is the common SQM→Bortle approximation used by light
// pollution maps. It's an estimate: Bortle is a whole-sky visual scale and
// zenith brightness alone can't capture horizon light domes.

const ATLAS_YEAR = 2024;
const TILE_BASE = `https://djlorenz.github.io/astronomy/binary_tiles/${ATLAS_YEAR}`;

const tileCache = new Map(); // url → Promise<Int8Array>

async function loadTile(url) {
  if (!tileCache.has(url)) {
    tileCache.set(url, (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Atlas tile HTTP ${res.status}`);
      let buf = await res.arrayBuffer();
      const head = new Uint8Array(buf, 0, 2);
      // Server may or may not transparently decompress; sniff the gzip magic.
      if (head[0] === 0x1f && head[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('Browser lacks DecompressionStream');
        }
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        buf = await new Response(stream).arrayBuffer();
      }
      return new Int8Array(buf);
    })());
    // Don't cache failures — allow a retry on the next call.
    tileCache.get(url).catch(() => tileCache.delete(url));
  }
  return tileCache.get(url);
}

/** SQM (mag/arcsec²) → approximate Bortle class 1–9. */
export function bortleFromMpsas(m) {
  if (m >= 21.99) return 1;
  if (m >= 21.89) return 2;
  if (m >= 21.69) return 3;
  if (m >= 20.49) return 4;
  if (m >= 19.50) return 5;
  if (m >= 18.94) return 6;
  if (m >= 18.38) return 7;
  if (m >= 17.80) return 8;
  return 9;
}

/**
 * Look up light pollution at a coordinate.
 * Returns { ratio, mpsas, bortle }. Throws outside the atlas's ±65°/75°
 * latitude coverage, on network failure, or in very old browsers.
 */
export async function fetchLightPollution(lat, lon) {
  if (lat < -64.99 || lat > 74.99) throw new Error('Outside atlas latitude coverage');

  const lonFDL = (((lon + 180) % 360) + 360) % 360; // degrees east of the date line
  const latFS = lat + 65;
  const tx = Math.floor(lonFDL / 5) + 1; // 1..72
  const ty = Math.floor(latFS / 5) + 1;  // 1..28
  const ix = Math.round(120 * (lonFDL - 5 * (tx - 1) + 1 / 240)); // 1..600
  const iy = Math.round(120 * (latFS - 5 * (ty - 1) + 1 / 240));  // 1..600

  const data = await loadTile(`${TILE_BASE}/binary_tile_${tx}_${ty}.dat.gz`);

  let v = 128 * data[0] + data[1];
  for (let i = 1; i < iy; i++) v += data[600 * i + 1];
  for (let i = 1; i < ix; i++) v += data[600 * (iy - 1) + 1 + i];

  const ratio = (5 / 195) * (Math.exp(0.0195 * v) - 1);
  const mpsas = 22.0 - 5.0 * Math.log(1 + ratio) / Math.log(100);
  return { ratio, mpsas, bortle: bortleFromMpsas(mpsas) };
}
