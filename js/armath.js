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

export function orientationToView(alpha, beta, gamma, screenAngle = 0) {
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
  const ys = [
    -R[0][0] * sS + R[0][1] * cS,
    -R[1][0] * sS + R[1][1] * cS,
    -R[2][0] * sS + R[2][1] * cS,
  ]; // screen-up in earth frame
  const v = [-R[0][2], -R[1][2], -R[2][2]]; // back-camera direction

  const az = wrap360(Math.atan2(v[0], v[1]) * RAD);
  const alt = Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD;

  // roll: screen-up vs "up in view", around the view axis.
  // right = v × worldUp = (v.y, −v.x, 0); upInView = right × v.
  let rx = v[1];
  let ry = -v[0];
  const rl = Math.hypot(rx, ry);
  let roll = 0;
  if (rl > 1e-9) {
    rx /= rl;
    ry /= rl;
    const ux = ry * v[2];
    const uy = -rx * v[2];
    const uz = rx * v[1] - ry * v[0];
    roll = Math.atan2(ys[0] * rx + ys[1] * ry, ys[0] * ux + ys[1] * uy + ys[2] * uz) * RAD;
  }
  return { az, alt, roll };
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
