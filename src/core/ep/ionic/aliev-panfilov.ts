import { f, type IonicModel } from './types';

/**
 * Aliev–Panfilov model (Aliev & Panfilov 1996), dimensionless form with time scale T (ms per unit):
 *   du/dτ = k u(1−u)(u−a) − u r
 *   dr/dτ = (ε0 + μ1 r/(u+μ2)) (−r − k u(u−a−1)),   τ = t / T
 * apdScale stretches the recovery equation (larger = longer APD).
 */
export interface ApParams {
  k: number;
  a: number;
  eps0: number;
  mu1: number;
  mu2: number;
  /** ms per dimensionless time unit. */
  T: number;
}

export const AP_DEFAULT: ApParams = { k: 8, a: 0.15, eps0: 0.002, mu1: 0.2, mu2: 0.3, T: 9 };

export class AlievPanfilov implements IonicModel {
  readonly id = 'ap' as const;
  readonly name = 'Aliev–Panfilov';
  readonly gates = 1;
  readonly recommendedDt = 0.05;
  constructor(readonly p: ApParams = AP_DEFAULT) {}

  restState(): [number, number, number] {
    return [0, 0, 0];
  }

  react(v: Float32Array, g0: Float32Array, _g1: Float32Array, n: number, dt: number, apdScale: Float32Array, excitable: Uint8Array): void {
    const { k, a, eps0, mu1, mu2, T } = this.p;
    const s = dt / T;
    for (let i = 0; i < n; i++) {
      const u = v[i]!;
      if (!excitable[i]) {
        v[i] = u - s * k * u;
        continue;
      }
      const r = g0[i]!;
      const du = k * u * (1 - u) * (u - a) - u * r;
      const dr = ((eps0 + (mu1 * r) / (u + mu2)) * (-r - k * u * (u - a - 1))) / apdScale[i]!;
      const un = u + s * du;
      v[i] = un < -0.2 ? -0.2 : un > 1.3 ? 1.3 : un;
      g0[i] = r + s * dr;
    }
  }

  wgsl(): string {
    const { k, a, eps0, mu1, mu2, T } = this.p;
    return /* wgsl */ `
fn react(v: f32, g0: f32, g1: f32, apd: f32, dt: f32, excitable: bool) -> vec3<f32> {
  let s = dt / ${f(T)};
  if (!excitable) { return vec3<f32>(v - s * ${f(k)} * v, g0, g1); }
  let du = ${f(k)} * v * (1.0 - v) * (v - ${f(a)}) - v * g0;
  let dr = (${f(eps0)} + ${f(mu1)} * g0 / (v + ${f(mu2)})) * (-g0 - ${f(k)} * v * (v - ${f(a)} - 1.0)) / apd;
  return vec3<f32>(clamp(v + s * du, -0.2, 1.3), g0 + s * dr, g1);
}`;
  }

  describe(): Record<string, number> {
    return { ...this.p };
  }
}
