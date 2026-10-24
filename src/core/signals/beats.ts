/**
 * Online reference-beat detection and window extraction (MODEL.md §4.2). The reference is the
 * peak |x| of a CS bipolar channel: a sample becomes a candidate when it exceeds 40 % of the
 * recent (3 s) peak amplitude, and is confirmed once 15 ms pass without a larger value; peaks
 * closer than the refractory interval to the previous reference are ignored. When the samples
 * after a reference are complete, a window [ref − pre, ref + post] of the requested channels is
 * emitted. Everything here runs on recorded signals only.
 */
export interface BeatSlice {
  /** Simulated time (ms) of the reference activation. */
  refTime: number;
  /** Interval from the previous reference (ms), NaN for the first. */
  cl: number;
  fs: number;
  /** Milliseconds of signal before the reference in each window. */
  preMs: number;
  /** Channel index → window samples. */
  data: Map<number, Float32Array>;
}

export interface BeatExtractorOptions {
  fs: number;
  nCh: number;
  refChannel: number;
  preMs: number;
  postMs: number;
  /** Ring-buffer length, seconds. */
  bufferSeconds?: number;
  refractoryMs?: number;
}

export class BeatExtractor {
  private buf: Float32Array[];
  private readonly cap: number;
  private total = 0;
  private t0 = 0;
  private candidate: { i: number; v: number } | null = null;
  private lastRef = -Infinity;
  private pending: number[] = [];
  private blockMax: number[] = [];
  private blockCur = 0;
  private blockFill = 0;
  private readonly blockLen: number;
  refChannel: number;

  constructor(private readonly o: BeatExtractorOptions) {
    this.cap = Math.round((o.bufferSeconds ?? 4) * o.fs);
    this.buf = Array.from({ length: o.nCh }, () => new Float32Array(this.cap));
    this.refChannel = o.refChannel;
    this.blockLen = Math.round(o.fs / 10); // 100 ms blocks for the running peak
  }

  private get pre(): number {
    return Math.round((this.o.preMs * this.o.fs) / 1000);
  }

  private get post(): number {
    return Math.round((this.o.postMs * this.o.fs) / 1000);
  }

  setReference(ch: number): void {
    this.refChannel = ch;
    this.candidate = null;
    this.blockMax = [];
    this.pending = [];
  }

  /** Append n samples (n × nCh row-major) starting at time t0 (ms). Returns completed windows. */
  push(t0: number, data: Float32Array, n: number, channels: number[]): BeatSlice[] {
    const { fs, nCh } = this.o;
    if (this.total === 0) this.t0 = t0;
    const expected = this.t0 + (this.total * 1000) / fs;
    if (Math.abs(t0 - expected) > 1.5 * (1000 / fs)) {
      // Discontinuity (rebuild): restart.
      this.total = 0;
      this.t0 = t0;
      this.candidate = null;
      this.lastRef = -Infinity;
      this.pending = [];
      this.blockMax = [];
    }
    const refr = Math.round(((this.o.refractoryMs ?? 150) * fs) / 1000);
    const confirm = Math.round(0.015 * fs);
    for (let s = 0; s < n; s++) {
      const i = this.total + s;
      const slot = i % this.cap;
      for (let c = 0; c < nCh; c++) this.buf[c]![slot] = data[s * nCh + c]!;
      const a = Math.abs(data[s * nCh + this.refChannel]!);
      // Running peak over the last 3 s from 100 ms block maxima.
      this.blockCur = Math.max(this.blockCur, a);
      if (++this.blockFill === this.blockLen) {
        this.blockMax.push(this.blockCur);
        if (this.blockMax.length > 30) this.blockMax.shift();
        this.blockCur = 0;
        this.blockFill = 0;
      }
      const peak = Math.max(this.blockCur, ...this.blockMax);
      if (peak > 0 && a >= 0.4 * peak && i - this.lastRef >= refr) {
        if (!this.candidate || a > this.candidate.v) this.candidate = { i, v: a };
      }
      if (this.candidate && i - this.candidate.i >= confirm) {
        this.pending.push(this.candidate.i);
        this.lastRef = this.candidate.i;
        this.candidate = null;
      }
    }
    this.total += n;
    const out: BeatSlice[] = [];
    const first = Math.max(0, this.total - this.cap);
    while (this.pending.length && this.pending[0]! + this.post < this.total) {
      const r = this.pending.shift()!;
      const prevIdx = this.prevRef;
      this.prevRef = r;
      if (r - this.pre < first) continue;
      const len = this.pre + this.post + 1;
      const data = new Map<number, Float32Array>();
      for (const c of channels) {
        const w = new Float32Array(len);
        for (let k = 0; k < len; k++) w[k] = this.buf[c]![(r - this.pre + k) % this.cap]!;
        data.set(c, w);
      }
      out.push({
        refTime: this.t0 + (r * 1000) / fs,
        cl: Number.isFinite(prevIdx) ? ((r - prevIdx) * 1000) / fs : NaN,
        fs,
        preMs: this.o.preMs,
        data,
      });
    }
    return out;
  }

  private prevRef = -Infinity;
}
