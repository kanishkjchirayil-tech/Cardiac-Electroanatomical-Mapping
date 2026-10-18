import { Rng } from '../rng';

/**
 * Recording artifacts (MODEL.md §3.3), added to raw unipolar potentials before referencing and
 * filtering, so bipolar subtraction rejects the common-mode part as in a real amplifier:
 *  - mains interference: common-mode sinusoid (50/60 Hz) plus a small per-electrode differential part;
 *  - baseline wander: respiration-frequency drift (common) plus slow per-electrode drift;
 *  - colored noise: per-electrode AR(2) process (low-pass "1/f-like" amplifier and tissue noise).
 */
export interface NoiseSpec {
  /** Mains frequency, Hz. */
  lineFreq: number;
  /** Common-mode mains amplitude, mV. */
  lineAmp: number;
  /** Fraction of the mains amplitude that differs between electrodes. */
  lineDifferential: number;
  /** Baseline wander amplitude, mV (respiration at ~0.25 Hz). */
  wanderAmp: number;
  /** AR(2) noise standard deviation, mV. */
  noiseSd: number;
  /** AR(2) coefficients (stationary). */
  ar: [number, number];
}

export const DEFAULT_NOISE: NoiseSpec = {
  lineFreq: 50,
  lineAmp: 0.15,
  lineDifferential: 0.03,
  wanderAmp: 0.3,
  noiseSd: 0.012,
  ar: [1.2, -0.36],
};

export const NO_NOISE: NoiseSpec = { ...DEFAULT_NOISE, lineAmp: 0, wanderAmp: 0, noiseSd: 0 };

export class ElectrodeNoise {
  private e1 = 0;
  private e2 = 0;
  private readonly rng: Rng;
  private readonly linePhase: number;
  private readonly lineGain: number;
  private readonly wanderPhase: number;
  private readonly innovationSd: number;

  constructor(readonly spec: NoiseSpec, seed: number) {
    this.rng = new Rng(seed);
    // Mains pickup is nearly in phase across electrodes; the mismatch is mostly in amplitude.
    this.linePhase = this.rng.uniform(-0.02, 0.02);
    this.lineGain = 1 + this.rng.normal(0, spec.lineDifferential);
    this.wanderPhase = this.rng.uniform(0, 2 * Math.PI);
    // Innovation SD giving the requested stationary SD for AR(2): Var = σ²(1−a2)/((1+a2)((1−a2)²−a1²)).
    const [a1, a2] = spec.ar;
    const varFactor = (1 - a2) / ((1 + a2) * ((1 - a2) ** 2 - a1 * a1));
    this.innovationSd = spec.noiseSd / Math.sqrt(varFactor);
  }

  /** Noise sample at time t (ms). */
  sample(t: number): number {
    const s = this.spec;
    const ts = t / 1000;
    const line = s.lineAmp * this.lineGain * Math.sin(2 * Math.PI * s.lineFreq * ts + this.linePhase);
    const wander = s.wanderAmp * (0.8 * Math.sin(2 * Math.PI * 0.25 * ts) + 0.2 * Math.sin(2 * Math.PI * 0.07 * ts + this.wanderPhase));
    const e = s.ar[0] * this.e1 + s.ar[1] * this.e2 + this.rng.normal(0, this.innovationSd);
    this.e2 = this.e1;
    this.e1 = e;
    return line + wander + e;
  }
}
