/**
 * Causal IIR filters for streaming EGM/ECG processing (RBJ audio-EQ cookbook biquads).
 * A band-pass is a 2nd-order Butterworth high-pass followed by a 2nd-order Butterworth low-pass,
 * each applied twice (4th order overall), as in typical recording-system front ends.
 */
export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}

  static lowpass(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * fc) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }

  static highpass(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * fc) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0);
  }

  static notch(f0: number, fs: number, q = 30): Biquad {
    const w = (2 * Math.PI * f0) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    return new Biquad(1 / a0, (-2 * c) / a0, 1 / a0, (-2 * c) / a0, (1 - al) / a0);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  /** Magnitude response at frequency f (for tests / documentation). */
  gain(f: number, fs: number): number {
    const w = (2 * Math.PI * f) / fs;
    const re = (a: number, b: number, c: number) => a + b * Math.cos(-w) + c * Math.cos(-2 * w);
    const im = (b: number, c: number) => b * Math.sin(-w) + c * Math.sin(-2 * w);
    const nr = re(this.b0, this.b1, this.b2), ni = im(this.b1, this.b2);
    const dr = re(1, this.a1, this.a2), di = im(this.a1, this.a2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

export interface BandSpec {
  /** High-pass corner (Hz); 0 disables. */
  hp: number;
  /** Low-pass corner (Hz); 0 or ≥ fs/2 disables. */
  lp: number;
  /** Mains notch frequency (Hz); 0 disables. */
  notch: number;
}

export class FilterChain {
  private stages: Biquad[];
  constructor(spec: BandSpec, readonly fs: number) {
    this.stages = [];
    if (spec.hp > 0) this.stages.push(Biquad.highpass(spec.hp, fs), Biquad.highpass(spec.hp, fs));
    if (spec.lp > 0 && spec.lp < fs / 2) this.stages.push(Biquad.lowpass(spec.lp, fs), Biquad.lowpass(spec.lp, fs));
    if (spec.notch > 0) this.stages.push(Biquad.notch(spec.notch, fs));
  }

  process(x: number): number {
    let y = x;
    for (const s of this.stages) y = s.process(y);
    return y;
  }

  gain(f: number): number {
    return this.stages.reduce((g, s) => g * s.gain(f, this.fs), 1);
  }

  reset(): void {
    for (const s of this.stages) s.reset();
  }
}

export const BIPOLAR_BAND: BandSpec = { hp: 30, lp: 500, notch: 0 };
export const UNIPOLAR_BAND: BandSpec = { hp: 1, lp: 240, notch: 0 };
export const ECG_BAND: BandSpec = { hp: 0.5, lp: 100, notch: 0 };
