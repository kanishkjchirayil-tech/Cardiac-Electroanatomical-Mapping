/**
 * Simple activation detector for a bipolar reference channel: local maxima of |x| above a
 * fraction of the recent peak amplitude, separated by a refractory window (MODEL.md §3.5).
 */
export function detectActivations(x: ArrayLike<number>, fs: number, opts: { threshold?: number; refractoryMs?: number; windowMs?: number } = {}): number[] {
  const thr = opts.threshold ?? 0.4;
  const refr = Math.round(((opts.refractoryMs ?? 120) * fs) / 1000);
  const win = opts.windowMs === undefined ? Infinity : Math.round((opts.windowMs * fs) / 1000);
  // Global peak unless a sliding window is requested (cheaper, and adequate for a regular rhythm).
  let global = 0;
  if (!Number.isFinite(win)) for (let i = 0; i < x.length; i++) global = Math.max(global, Math.abs(x[i]!));
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < x.length - 1; i++) {
    const a = Math.abs(x[i]!);
    if (a < Math.abs(x[i - 1]!) || a < Math.abs(x[i + 1]!)) continue;
    let peak = global;
    if (Number.isFinite(win)) for (let j = Math.max(0, i - win); j < Math.min(x.length, i + win); j += 4) peak = Math.max(peak, Math.abs(x[j]!));
    if (a < thr * peak || peak === 0) continue;
    if (i - last < refr) {
      // Keep the larger of two peaks within the refractory window.
      if (a > Math.abs(x[out[out.length - 1]!]!)) out[out.length - 1] = i;
      continue;
    }
    out.push(i);
    last = i;
  }
  return out;
}

/** Median of successive intervals (ms) between detections; NaN if fewer than 2. */
export function cycleLength(indices: number[], fs: number, last = 6): number {
  const iv = indices.slice(1).map((v, i) => ((v - indices[i]!) * 1000) / fs).slice(-last).sort((a, b) => a - b);
  if (!iv.length) return NaN;
  const m = iv.length >> 1;
  return iv.length % 2 ? iv[m]! : 0.5 * (iv[m - 1]! + iv[m]!);
}
