// js/armath.js — pure math for AR mode: W3C deviceorientation angles →
// where the BACK CAMERA points, as {az, alt, roll}. DOM-free, Node-tested.
//
// Frames: earth x=East, y=North, z=Up (W3C). Device angles are intrinsic
// Z-X'-Y'' (alpha about z, beta about x', gamma about y''), so
// R = Rz(α)·Rx(β)·Ry(γ) maps device coords → earth coords. The screen may be
// rotated relative to the device (landscape): compensate with R′ = R·Rz(s).
// View direction = −(device z) = −(3rd column of R′). Azimuth here is
// MAGNETIC (sensor-referenced); the caller adds WMM declination for true az.
//
// Sign conventions locked by tests; if field-testing shows a mirrored axis
// on some device, fix it HERE (one sign), never in the callers.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function wrap360(d) {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

/** Wrap to (−180, 180]. */
export function wrap180(d) {
  d = wrap360(d);
  return d > 180 ? d - 360 : d;
}

/**
 * Full orientation as a view BASIS: f = back-camera direction, u = screen-up,
 * both unit vectors in the earth frame and mutually orthogonal. This is the
 * singularity-free representation — smooth THIS (smoothBasis), correct
 * heading on THIS (rotateBasisZ), and only decompose to {az, alt, roll} at
 * the last moment (basisToView). Decomposed angles individually blow up near
 * the zenith; the basis never does (2026-08-03 field bug: "jumping in
 * circles looking straight up").
 */
export function orientationToBasis(alpha, beta, gamma, screenAngle = 0) {
  const cA = Math.cos(alpha * DEG);
  const sA = Math.sin(alpha * DEG);
  const cB = Math.cos(beta * DEG);
  const sB = Math.sin(beta * DEG);
  const cG = Math.cos(gamma * DEG);
  const sG = Math.sin(gamma * DEG);
  // R = Rz(alpha)·Rx(beta)·Ry(gamma), columns are device axes in earth frame
  const R = [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG, sB, cB * cG],
  ];
  // Screen axes = device axes rotated by screenAngle about device z
  const cS = Math.cos(screenAngle * DEG);
  const sS = Math.sin(screenAngle * DEG);
  return {
    f: [-R[0][2], -R[1][2], -R[2][2]], // back-camera direction
    u: [
      -R[0][0] * sS + R[0][1] * cS,
      -R[1][0] * sS + R[1][1] * cS,
      -R[2][0] * sS + R[2][1] * cS,
    ], // screen-up in earth frame
  };
}

/** Shift a basis's azimuth by `deg` (heading corrections: declination and
 * compass fusion are both rotations about the world's vertical axis). */
export function rotateBasisZ(basis, deg) {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const rot = (v) => [v[0] * c + v[1] * s, v[1] * c - v[0] * s, v[2]];
  return { f: rot(basis.f), u: rot(basis.u) };
}

/** Exponential low-pass on a basis: lerp both vectors, then re-orthonormalize
 * (Gram-Schmidt). Smoothing the rigid frame keeps az and roll mutually
 * consistent through the zenith, where smoothing them separately spins. */
export function smoothBasis(prev, next, k) {
  if (!prev) return next;
  const mix = (a, b) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  let f = mix(prev.f, next.f);
  const fn = Math.hypot(f[0], f[1], f[2]) || 1;
  f = [f[0] / fn, f[1] / fn, f[2] / fn];
  let u = mix(prev.u, next.u);
  const d = u[0] * f[0] + u[1] * f[1] + u[2] * f[2];
  u = [u[0] - d * f[0], u[1] - d * f[1], u[2] - d * f[2]];
  const un = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / un, u[1] / un, u[2] / un];
  return { f, u };
}

/**
 * Decompose a basis into {az, alt, roll} for the renderer — atomically, so
 * az and roll always describe the SAME frame (their rapid compensating
 * swings near the zenith cancel in the rendered picture). At the exact
 * zenith/nadir the view direction carries no azimuth, so it is taken from
 * where screen-up points instead, with roll 0 — continuous with the
 * near-pole decomposition on either side.
 */
export function basisToView(basis) {
  const [fe, fN, fu] = basis.f;
  const [ue, uN, uu] = basis.u;
  const alt = Math.asin(Math.max(-1, Math.min(1, fu))) * RAD;
  const h = Math.hypot(fe, fN);
  if (h < 1e-9) {
    return { az: wrap360(Math.atan2(ue, uN) * RAD), alt, roll: 0 };
  }
  const az = wrap360(Math.atan2(fe, fN) * RAD);
  // right = f × worldUp (normalized); upInView = right × f
  const rx = fN / h;
  const ry = -fe / h;
  const ux = ry * fu;
  const uy = -rx * fu;
  const uz = rx * fN - ry * fe;
  const roll = Math.atan2(ue * rx + uN * ry, ue * ux + uN * uy + uu * uz) * RAD;
  return { az, alt, roll };
}

export function orientationToView(alpha, beta, gamma, screenAngle = 0) {
  return basisToView(orientationToBasis(alpha, beta, gamma, screenAngle));
}

/** Exponential low-pass on a view. Blends the direction as a 3-vector so the
 * az 0/360 seam never glitches; roll blends by shortest arc. k in (0, 1]. */
export function smoothView(prev, next, k) {
  if (!prev) return next;
  const toVec = (w) => {
    const ca = Math.cos(w.alt * DEG);
    return [ca * Math.sin(w.az * DEG), ca * Math.cos(w.az * DEG), Math.sin(w.alt * DEG)];
  };
  const a = toVec(prev);
  const b = toVec(next);
  const m = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const n = Math.hypot(m[0], m[1], m[2]) || 1;
  const az = wrap360(Math.atan2(m[0] / n, m[1] / n) * RAD);
  const alt = Math.asin(Math.max(-1, Math.min(1, m[2] / n))) * RAD;
  const roll = prev.roll + wrap180(next.roll - prev.roll) * k;
  return { az, alt, roll };
}

/** iOS compass fusion: webkitCompassHeading is magnetic and absolute, alpha is
 * smooth but arbitrarily referenced. Maintain offset so alpha+offset ≈ absolute
 * alpha. Snap on first sample, then converge slowly (compass is noisy). */
export function headingOffset(prevOffset, alpha, compassHeading, k) {
  const target = wrap360(360 - compassHeading - alpha);
  if (prevOffset === null || prevOffset === undefined) return target;
  return wrap360(prevOffset + wrap180(target - prevOffset) * k);
}
