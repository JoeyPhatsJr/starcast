// js/wmm.js — magnetic declination from the World Magnetic Model (degree-12
// spherical harmonics, coefficients in ./wmmcof.js). Sea-level only: Starcast
// corrects a phone compass, and the difference over any terrestrial elevation
// is far below the compass's own noise. Validated against NOAA's official
// WMM2025 test values in tests/wmm.test.mjs.
//
// Convention: declination is EAST-POSITIVE (NYC ≈ −12.5°).
// True azimuth = magnetic azimuth + declination.
import { WMM_EPOCH, WMM_TERMS } from './wmmcof.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const N_MAX = 12;

/** Decimal year of a Date (UTC), e.g. 2026-07-02 → ≈2026.5. */
export function decimalYear(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (date.getTime() - start) / (end - start);
}

/** Magnetic declination in degrees (east-positive) at sea level. */
export function declination(latDeg, lonDeg, decYear) {
  const dt = decYear - WMM_EPOCH;
  // Geodetic (WGS84, h=0) → geocentric
  const a = 6378.137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const sinPhi = Math.sin(phi);
  const Rc = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const p = Rc * Math.cos(phi);
  const zz = Rc * (1 - e2) * sinPhi;
  const r = Math.hypot(p, zz);
  const phiP = Math.asin(zz / r); // geocentric latitude
  const s = Math.sin(phiP);
  const c = Math.cos(phiP);

  // Unnormalized associated Legendre P[n][m](sin φ′) and d/dφ′:
  //   P_mm = (2m−1)·c·P_{m−1,m−1};  P_nm = ((2n−1)·s·P_{n−1,m} − (n+m−1)·P_{n−2,m})/(n−m)
  //   dP/dφ′ = −(n·s·P_nm − (n+m)·P_{n−1,m})/c   [from the (x²−1)·P′ identity]
  const P = [];
  const dP = [];
  for (let n = 0; n <= N_MAX; n++) {
    P.push(new Array(n + 1).fill(0));
    dP.push(new Array(n + 1).fill(0));
  }
  P[0][0] = 1;
  for (let m = 1; m <= N_MAX; m++) P[m][m] = (2 * m - 1) * c * P[m - 1][m - 1];
  for (let m = 0; m < N_MAX; m++) {
    for (let n = m + 1; n <= N_MAX; n++) {
      const Pn2 = n - 2 >= m ? P[n - 2][m] : 0;
      P[n][m] = ((2 * n - 1) * s * P[n - 1][m] - (n + m - 1) * Pn2) / (n - m);
    }
  }
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const Pn1 = n - 1 >= m ? P[n - 1][m] : 0;
      dP[n][m] = -(n * s * P[n][m] - (n + m) * Pn1) / c;
    }
  }

  // Schmidt semi-normalization, built incrementally:
  // S[n][0] = 1;  S[n][m] = S[n][m−1]·sqrt((m==1?2:1)/((n+m)(n−m+1)))
  const S = [];
  for (let n = 0; n <= N_MAX; n++) {
    S.push(new Array(n + 1).fill(0));
    S[n][0] = 1;
    for (let m = 1; m <= n; m++) {
      S[n][m] = S[n][m - 1] * Math.sqrt((m === 1 ? 2 : 1) / ((n + m) * (n - m + 1)));
    }
  }

  // Time-adjusted coefficients
  const G = [];
  const H = [];
  for (let n = 0; n <= N_MAX; n++) {
    G.push(new Array(n + 1).fill(0));
    H.push(new Array(n + 1).fill(0));
  }
  for (const [n, m, g, h, gd, hd] of WMM_TERMS) {
    G[n][m] = g + dt * gd;
    H[n][m] = h + dt * hd;
  }

  // Field components in geocentric frame (X′ north, Y′ east, Z′ down)
  const aGeo = 6371.2;
  let Xp = 0;
  let Yp = 0;
  let Zp = 0;
  for (let n = 1; n <= N_MAX; n++) {
    const ar = Math.pow(aGeo / r, n + 2);
    for (let m = 0; m <= n; m++) {
      const Pb = S[n][m] * P[n][m];
      const dPb = S[n][m] * dP[n][m];
      const cm = Math.cos(m * lam);
      const sm = Math.sin(m * lam);
      const gcs = G[n][m] * cm + H[n][m] * sm;
      Xp += -ar * gcs * dPb;
      Yp += (ar * m * (G[n][m] * sm - H[n][m] * cm) * Pb) / c;
      Zp += -(n + 1) * ar * gcs * Pb;
    }
  }

  // Rotate X′/Z′ from geocentric to geodetic frame; declination from X, Y
  const psi = phiP - phi;
  const X = Xp * Math.cos(psi) - Zp * Math.sin(psi);
  return Math.atan2(Yp, X) * RAD;
}
