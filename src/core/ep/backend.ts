import type { IonicModel } from './ionic';
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
  dispose(): void;
}

export const ACT_THRESHOLD = 0.5;
export const REPOL_THRESHOLD = 0.1;
