/**
 * Ionic model interface. All models use a normalized transmembrane variable v ∈ [0, 1]
 * (0 = rest, 1 = peak) plus up to two gate variables. Mapping to millivolts uses
 * Vm = V_REST + v·(V_PEAK − V_REST). See MODEL.md §2.2.
 */
export const V_REST_MV = -80;
export const V_PEAK_MV = 20;
export const vToMv = (v: number): number => V_REST_MV + v * (V_PEAK_MV - V_REST_MV);

export type IonicModelId = 'ms' | 'ap' | 'fk';

export interface IonicModel {
  readonly id: IonicModelId;
  readonly name: string;
  /** Number of gate variables (0–2). */
  readonly gates: number;
  /** Time step (ms) at which this model is accurate with the explicit scheme (MODEL.md §2.2). */
  readonly recommendedDt: number;
  /** Resting values [v, g0, g1]. */
  restState(): [number, number, number];
  /**
   * Advance the local reaction by dt (ms) for vertices [0, n).
   * `apdScale` multiplies the model's repolarization time constant (1 = baseline).
   * Inexcitable vertices (excitable[i] = 0) relax passively towards rest.
   */
  react(v: Float32Array, g0: Float32Array, g1: Float32Array, n: number, dt: number, apdScale: Float32Array, excitable: Uint8Array): void;
  /**
   * WGSL source defining `fn react(v: f32, g0: f32, g1: f32, apd: f32, dt: f32) -> vec3<f32>`
   * that implements exactly the same update as `react` (single precision).
   */
  wgsl(): string;
  /** Parameters for documentation / UI. */
  describe(): Record<string, number>;
}

/** WGSL number literal (always with a decimal point). */
export const f = (x: number): string => {
  const s = String(x);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};
