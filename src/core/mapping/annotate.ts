import type { Annotation, EgmWindowData, LatMethod, Woi } from './types';

/**
 * Automatic EGM annotation (MODEL.md §4.3).
 *  - Reference: peak |ref| within ±20 ms of the window's nominal reference.
 *  - LAT (unipolar, default): time of the most negative slope of the unipolar EGM within the
 *    WOI (5-point derivative over 2 ms, parabolic sub-sample refinement).
 *  - LAT (bipolar): time of the peak |bipolar| within the WOI.
 *  - Voltages: peak-to-peak within the WOI.
 *  - Fractionation: alternating bipolar deflections counted with hysteresis
 *    h = max(10 % of the bipolar peak-to-peak, 0.03 mV); fractionated if ≥ 6 deflections or
 *    ≥ 50 ms of activity above 15 % of peak |bip|.
 *  - Double potential: exactly two activity clusters (each peaking ≥ 30 % of max) separated by an
 *    isoelectric gap ≥ 30 ms.
 */
export const NOISE_FLOOR_MV = 0.03;

export function annotate(w: EgmWindowData, woi: Woi, method: LatMethod): Annotation {
  const fs = w.fs, dt = 1000 / fs;
  const nominal = Math.round((w.preMs * fs) / 1000);
  // Refine the reference.
  const sr = Math.round(0.02 * fs);
  let ri = nominal, rv = -1;
  for (let i = Math.max(0, nominal - sr); i <= Math.min(w.ref.length - 1, nominal + sr); i++) {
    const a = Math.abs(w.ref[i]!);
    if (a > rv) { rv = a; ri = i; }
  }
  const refOffset = (ri - nominal) * dt;
  const i0 = Math.max(2, Math.round(ri + (woi.start * fs) / 1000));
  const i1 = Math.min(w.uni.length - 3, Math.round(ri + (woi.end * fs) / 1000));
  const tOf = (i: number) => (i - ri) * dt;

  let bMin = Infinity, bMax = -Infinity, uMin = Infinity, uMax = -Infinity, bAbsMax = 0, bAbsAt = i0;
  for (let i = i0; i <= i1; i++) {
    const b = w.bip[i]!, u = w.uni[i]!;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (Math.abs(b) > bAbsMax) { bAbsMax = Math.abs(b); bAbsAt = i; }
  }
  const bipolarVoltage = bMax - bMin, unipolarVoltage = uMax - uMin;

  let lat = NaN;
  if (method === 'unipolar') {
    const d = (i: number) => (-w.uni[i + 2]! + 8 * w.uni[i + 1]! - 8 * w.uni[i - 1]! + w.uni[i - 2]!) / (12 * dt);
    let best = Infinity, at = -1;
    for (let i = i0; i <= i1; i++) {
      const s = d(i);
      if (s < best) { best = s; at = i; }
    }
    if (at >= 0 && best < 0) lat = tOf(at) + parabolicOffset(d(at - 1), best, d(at + 1)) * dt;
  } else if (bAbsMax > NOISE_FLOOR_MV) {
    lat = tOf(bAbsAt) + parabolicOffset(Math.abs(w.bip[bAbsAt - 1]!), bAbsMax, Math.abs(w.bip[bAbsAt + 1]!)) * dt;
  }

  // Deflections = number of alternating extrema, found with hysteresis h (reversals + 1).
  const h = Math.max(0.1 * bipolarVoltage, NOISE_FLOOR_MV);
  let reversals = 0, trend = 0, extreme = w.bip[i0]!;
  for (let i = i0 + 1; i <= i1; i++) {
    const x = w.bip[i]!;
    if (trend >= 0) {
      if (x > extreme) extreme = x;
      else if (extreme - x > h) { if (trend > 0) reversals++; trend = -1; extreme = x; }
    }
    if (trend <= 0) {
      if (x < extreme) extreme = x;
      else if (x - extreme > h) { if (trend < 0) reversals++; trend = 1; extreme = x; }
    }
  }
  const deflections = bAbsMax > NOISE_FLOOR_MV ? reversals + 1 : 0;
  // Activity clusters above 15 % of peak |bip|.
  const thr = Math.max(0.15 * bAbsMax, NOISE_FLOOR_MV);
  const clusters: Array<{ a: number; b: number; peak: number }> = [];
  const gapSamples = Math.round(0.03 * fs);
  for (let i = i0; i <= i1; i++) {
    const a = Math.abs(w.bip[i]!);
    if (a < thr) continue;
    const last = clusters[clusters.length - 1];
    if (last && i - last.b < gapSamples) { last.b = i; last.peak = Math.max(last.peak, a); }
    else clusters.push({ a: i, b: i, peak: a });
  }
  const duration = clusters.length ? (clusters[clusters.length - 1]!.b - clusters[0]!.a) * dt : 0;
  const strong = clusters.filter((c) => c.peak >= 0.3 * bAbsMax);
  const doublePotential = bAbsMax > NOISE_FLOOR_MV && strong.length === 2 && clusters.length === 2;
  const fractionated = bAbsMax > NOISE_FLOOR_MV && !doublePotential && (deflections >= 6 || duration >= 50);
  return { lat, method, bipolarVoltage, unipolarVoltage, deflections, duration, fractionated, doublePotential, refOffset };
}

/** Vertex offset (−0.5..0.5) of a parabola through three equally spaced samples. */
function parabolicOffset(a: number, b: number, c: number): number {
  const den = a - 2 * b + c;
  if (den === 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
}
