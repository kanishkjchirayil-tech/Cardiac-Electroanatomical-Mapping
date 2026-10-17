import { f, type IonicModel } from './types';

/**
 * Mitchell–Schaeffer two-current model (Mitchell & Schaeffer 2003).
 *   dv/dt = h v²(1−v)/τin − v/τout
 *   dh/dt = (1−h)/τopen  if v < vgate,   −h/τclose  if v ≥ vgate
 * Gate h is integrated with the exact exponential (Rush–Larsen) update; v with forward Euler.
 * Maximal APD ≈ τclose · ln(τout / (4 τin)).
 */
export interface MsParams {
  tauIn: number;
  tauOut: number;
  tauOpen: number;
  tauClose: number;
  vGate: number;
}

export const MS_ATRIAL_DEFAULT: MsParams = { tauIn: 0.3, tauOut: 6, tauOpen: 120, tauClose: 130, vGate: 0.13 };

export class MitchellSchaeffer implements IonicModel {
  readonly id = 'ms' as const;
  readonly name = 'Mitchell–Schaeffer';
  readonly gates = 1;
  readonly recommendedDt = 0.1;
  constructor(readonly p: MsParams = MS_ATRIAL_DEFAULT) {}

  // exp(−dt/(τclose·apdScale_i)) per vertex, cached while dt and the apdScale array are unchanged.
  private closeDecay: Float32Array | null = null;
  private cacheKey: { dt: number; apd: Float32Array } | null = null;

  private decay(dt: number, apdScale: Float32Array, n: number): Float32Array {
    if (!this.closeDecay || this.cacheKey?.dt !== dt || this.cacheKey.apd !== apdScale || this.closeDecay.length < n) {
      this.closeDecay = new Float32Array(n);
      for (let i = 0; i < n; i++) this.closeDecay[i] = Math.exp(-dt / (this.p.tauClose * apdScale[i]!));
      this.cacheKey = { dt, apd: apdScale };
    }
    return this.closeDecay;
  }

  /** Call after mutating an apdScale array in place. */
  invalidate(): void {
    this.closeDecay = null;
  }

  restState(): [number, number, number] {
    return [0, 1, 0];
  }

  react(v: Float32Array, g0: Float32Array, _g1: Float32Array, n: number, dt: number, apdScale: Float32Array, excitable: Uint8Array): void {
    const { tauIn, tauOut, tauOpen, vGate } = this.p;
    const eOpen = Math.exp(-dt / tauOpen);
    const eClose = this.decay(dt, apdScale, n);
    for (let i = 0; i < n; i++) {
      let x = v[i]!;
      if (!excitable[i]) {
        v[i] = x - (dt * x) / tauOut;
        continue;
      }
      const h = g0[i]!;
      const dv = (h * x * x * (1 - x)) / tauIn - x / tauOut;
      x += dt * dv;
      x = x < -0.2 ? -0.2 : x > 1.3 ? 1.3 : x;
      v[i] = x;
      g0[i] = x < vGate ? 1 - (1 - h) * eOpen : h * eClose[i]!;
    }
  }

  wgsl(): string {
    const { tauIn, tauOut, tauOpen, tauClose, vGate } = this.p;
    return /* wgsl */ `
fn react(v: f32, g0: f32, g1: f32, apd: f32, dt: f32, excitable: bool) -> vec3<f32> {
  if (!excitable) { return vec3<f32>(v - dt * v / ${f(tauOut)}, g0, g1); }
  let dv = g0 * v * v * (1.0 - v) / ${f(tauIn)} - v / ${f(tauOut)};
  let vn = clamp(v + dt * dv, -0.2, 1.3);
  var h = g0;
  if (vn < ${f(vGate)}) { h = 1.0 - (1.0 - g0) * exp(-dt / ${f(tauOpen)}); }
  else { h = g0 * exp(-dt / (${f(tauClose)} * apd)); }
  return vec3<f32>(vn, h, g1);
}`;
  }

  describe(): Record<string, number> {
    return { ...this.p };
  }
}
