/**
 * Pacing measurements from recorded (processed) electrograms only (MODEL.md §6.1): stimulus-to-
 * local-activation intervals, local capture, 1:1 conduction to the CS, tachycardia cycle length
 * and the post-pacing interval. Nothing here reads tissue state.
 */

/** Ring buffer of processed channels with absolute sample indexing. */
export class SignalHistory {
  private buf: Float32Array[];
  total = 0;
  t0 = 0;
  readonly cap: number;

  constructor(readonly nCh: number, readonly fs: number, seconds = 6) {
    this.cap = Math.round(seconds * fs);
    this.buf = Array.from({ length: nCh }, () => new Float32Array(this.cap));
  }

  push(t0: number, data: Float32Array, n: number): void {
    const expected = this.t0 + (this.total * 1000) / this.fs;
    if (this.total === 0 || Math.abs(t0 - expected) > 1.5 * (1000 / this.fs)) {
      this.total = 0;
      this.t0 = t0;
    }
    for (let s = 0; s < n; s++) {
      const slot = (this.total + s) % this.cap;
      for (let c = 0; c < this.nCh; c++) this.buf[c]![slot] = data[s * this.nCh + c]!;
    }
    this.total += n;
  }

  /** Time of the newest sample, ms. */
  get tEnd(): number {
    return this.t0 + ((this.total - 1) * 1000) / this.fs;
  }

  /** Channel samples over [from, to) ms (clamped to what is held), with the time of the first sample. */
  window(ch: number, from: number, to: number): { t: number; x: Float32Array } {
    const first = Math.max(0, this.total - this.cap);
    const a = Math.max(first, Math.ceil(((from - this.t0) * this.fs) / 1000));
    const b = Math.min(this.total, Math.ceil(((to - this.t0) * this.fs) / 1000));
    const x = new Float32Array(Math.max(0, b - a));
    for (let i = a; i < b; i++) x[i - a] = this.buf[ch]![i % this.cap]!;
    return { t: this.t0 + (a * 1000) / this.fs, x };
  }
}

/** Minimum bipolar amplitude counted as a local activation, mV. */
export const LOCAL_ACTIVATION_MV = 0.05;

/**
 * Time (ms) of the first local activation in [from, to): the first local maximum of |x| that
 * exceeds max(minAmp, 0.3 × window peak). NaN if none.
 */
export function firstActivation(h: SignalHistory, ch: number, from: number, to: number, minAmp = LOCAL_ACTIVATION_MV): number {
  const { t, x } = h.window(ch, from, to);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const thr = Math.max(minAmp, 0.3 * peak);
  if (peak < minAmp) return NaN;
  for (let i = 1; i < x.length - 1; i++) {
    const a = Math.abs(x[i]!);
    if (a >= thr && a >= Math.abs(x[i - 1]!) && a >= Math.abs(x[i + 1]!)) return t + (i * 1000) / h.fs;
  }
  return NaN;
}

/** All local activations (peaks of |x| above threshold, ≥ refractory apart) in [from, to). */
export function activations(h: SignalHistory, ch: number, from: number, to: number, refractoryMs = 100, minAmp = LOCAL_ACTIVATION_MV): number[] {
  const { t, x } = h.window(ch, from, to);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak < minAmp) return [];
  const thr = Math.max(minAmp, 0.4 * peak);
  const out: number[] = [];
  const refr = (refractoryMs * h.fs) / 1000;
  let last = -Infinity;
  for (let i = 1; i < x.length - 1; i++) {
    const a = Math.abs(x[i]!);
    if (a < thr || a < Math.abs(x[i - 1]!) || a < Math.abs(x[i + 1]!)) continue;
    if (i - last < refr) continue;
    out.push(t + (i * 1000) / h.fs);
    last = i;
  }
  return out;
}

export function median(xs: number[]): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : 0.5 * (v[m - 1]! + v[m]!);
}

/** Median cycle length (ms) of a channel over [from, to). */
export function cycleLengthOf(h: SignalHistory, ch: number, from: number, to: number): number {
  const a = activations(h, ch, from, to);
  return median(a.slice(1).map((t, i) => t - a[i]!));
}
