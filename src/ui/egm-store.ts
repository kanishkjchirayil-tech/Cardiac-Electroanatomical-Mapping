import type { EgmChunk } from '../engine/protocol';

/**
 * Main-thread ring buffer of processed channel samples for the EGM panel (MODEL.md §3.5).
 * Keeps the most recent `seconds` of every channel, indexed by absolute sample number.
 */
export class EgmStore {
  readonly capacity: number;
  private buf: Float32Array[] = [];
  /** Absolute index of the next sample to be written. */
  total = 0;
  /** Simulated time (ms) of absolute sample 0. */
  t0 = 0;
  version = 0;

  constructor(public nCh: number, readonly fs: number, seconds = 30) {
    this.capacity = Math.round(seconds * fs);
    this.reset(nCh, 0);
  }

  reset(nCh: number, t0: number): void {
    this.nCh = nCh;
    this.buf = Array.from({ length: nCh }, () => new Float32Array(this.capacity));
    this.total = 0;
    this.t0 = t0;
    this.version++;
  }

  /** Time (ms) of the newest sample. */
  get tEnd(): number {
    return this.t0 + ((this.total - 1) * 1000) / this.fs;
  }

  append(c: EgmChunk): void {
    if (c.nCh !== this.nCh) this.reset(c.nCh, c.t0);
    const expected = this.t0 + (this.total * 1000) / this.fs;
    // A jump (reset, rebuild, or time going backwards) restarts the record.
    if (this.total === 0 || Math.abs(c.t0 - expected) > 1.5 * (1000 / this.fs)) this.reset(c.nCh, c.t0);
    for (let s = 0; s < c.n; s++) {
      const slot = (this.total + s) % this.capacity;
      for (let ch = 0; ch < c.nCh; ch++) this.buf[ch]![slot] = c.data[s * c.nCh + ch]!;
    }
    this.total += c.n;
    this.version++;
  }

  /** Oldest absolute sample index still held. */
  get first(): number {
    return Math.max(0, this.total - this.capacity);
  }

  /** Value of channel ch at absolute sample index i (caller ensures first ≤ i < total). */
  at(ch: number, i: number): number {
    return this.buf[ch]![i % this.capacity]!;
  }

  indexAt(t: number): number {
    return Math.round(((t - this.t0) * this.fs) / 1000);
  }

  timeAt(i: number): number {
    return this.t0 + (i * 1000) / this.fs;
  }

  /** Copy of channel ch over [from, to) absolute indices (clamped to what is held). */
  slice(ch: number, from: number, to: number): Float32Array {
    const a = Math.max(from, this.first), b = Math.min(to, this.total);
    const out = new Float32Array(Math.max(0, b - a));
    for (let i = a; i < b; i++) out[i - a] = this.at(ch, i);
    return out;
  }
}
