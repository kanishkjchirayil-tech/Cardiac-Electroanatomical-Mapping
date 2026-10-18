import type { IonicModel } from './ionic';
import type { LeadField } from '../signals/leadfield';
import type { TissueGeometry } from './fem';

/** Activation bookkeeping produced by every backend (ground truth; teacher view / tests only). */
export interface ActivationRecord {
  /** Time (ms) of the most recent upstroke (v crossing 0.5 upwards); −Infinity if none. */
  last: Float32Array;
  /** Time of the upstroke before `last`. */
  prev: Float32Array;
  /** Most recent repolarization (v crossing 0.1 downwards). */
  repol: Float32Array;
  count: Uint32Array;
}

export interface BackendInit {
  geom: TissueGeometry;
  model: IonicModel;
  /** Per-edge diffusivity, mm²/ms. */
  edgeD: Float32Array;
  apdScale: Float32Array;
  excitable: Uint8Array;
  /** Per-vertex stimulus site index (−1 none). */
  siteOf: Int32Array;
  dt: number;
}

/**
 * A tissue solver backend. The Simulation owns the clock and the stimulus schedule and hands the
 * backend per-step stimulus amplitudes (nSteps × MAX_STIM_SITES).
 */
export interface SolverBackend {
  readonly kind: 'cpu' | 'webgpu';
  readonly nV: number;
  readonly diffusionSubsteps: number;
  step(nSteps: number, t0: number, amps: Float32Array): void | Promise<void>;
  readV(): Float32Array | Promise<Float32Array>;
  readActivation(): ActivationRecord | Promise<ActivationRecord>;
  setEdgeDiffusivity(edgeD: Float32Array): void;
  setVertexParams(apdScale: Float32Array, excitable: Uint8Array): void;
  setSiteMap(siteOf: Int32Array): void;
  /** Overwrite state (v and gates) — used for initial conditions. */
  setState(v: Float32Array, g0?: Float32Array, g1?: Float32Array): void | Promise<void>;
  getState(): { v: Float32Array; g0: Float32Array; g1: Float32Array } | Promise<{ v: Float32Array; g0: Float32Array; g1: Float32Array }>;
  resetActivation(): void;
  /**
   * Electrogram sampling: every `sampleEvery` steps, evaluate φ_r = Σ w·v for each lead-field row
   * (at the end of the step). Replaces any previous rows; pass [] to stop sampling.
   */
  setLeadFields(rows: LeadField[], sampleEvery: number): void;
  /** Return and clear the samples collected since the last call. */
  drainSamples(): EgmSamples;
  dispose(): void;
}

export interface EgmSamples {
  /** Sample times (ms). */
  times: Float64Array;
  /** times.length × rows, row-major (mV). */
  data: Float32Array;
  rows: number;
}

/** Packs lead-field rows into CSR arrays shared by both backends. */
export function packLeadFields(rows: LeadField[]): { rowPtr: Uint32Array; idx: Uint32Array; w: Float32Array } {
  const rowPtr = new Uint32Array(rows.length + 1);
  rows.forEach((r, i) => (rowPtr[i + 1] = rowPtr[i]! + r.idx.length));
  const idx = new Uint32Array(rowPtr[rows.length]!), w = new Float32Array(rowPtr[rows.length]!);
  rows.forEach((r, i) => { idx.set(r.idx, rowPtr[i]!); w.set(r.w, rowPtr[i]!); });
  return { rowPtr, idx, w };
}

/** Accumulates samples in growable chunks. */
export class SampleBuffer {
  private times: number[] = [];
  private chunks: Float32Array[] = [];
  constructor(public rows: number) {}

  push(t: number, values: Float32Array): void {
    this.times.push(t);
    this.chunks.push(values);
  }

  pushBlock(times: number[], data: Float32Array): void {
    for (let i = 0; i < times.length; i++) {
      this.times.push(times[i]!);
      this.chunks.push(data.subarray(i * this.rows, (i + 1) * this.rows));
    }
  }

  drain(): EgmSamples {
    const n = this.times.length;
    const data = new Float32Array(n * this.rows);
    this.chunks.forEach((c, i) => data.set(c, i * this.rows));
    const out = { times: Float64Array.from(this.times), data, rows: this.rows };
    this.times = [];
    this.chunks = [];
    return out;
  }
}

export const ACT_THRESHOLD = 0.5;
export const REPOL_THRESHOLD = 0.1;
