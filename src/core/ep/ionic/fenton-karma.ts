import { f, type IonicModel } from './types';

/**
 * Fenton–Karma three-variable model (Fenton & Karma 1998; parameter set 1 of Fenton et al. 2002,
 * transcribed — verify against the source before research use). Gates: g0 = v (fast), g1 = w (slow).
 *   Jfi = −(v/τd) H(u−uc)(1−u)(u−uc)
 *   Jso =  (u/τo)(1−H(u−uc)) + H(u−uc)/τr
 *   Jsi = −(w/(2τsi))(1 + tanh(k(u−ucsi)))
 *   du/dt = −(Jfi + Jso + Jsi)
 * apdScale multiplies τw+ and τr (plateau duration).
 */
export interface FkParams {
  tauVPlus: number;
  tauV1Minus: number;
  tauV2Minus: number;
  tauWPlus: number;
  tauWMinus: number;
  tauD: number;
  tauO: number;
  tauR: number;
  tauSi: number;
  k: number;
  uCsi: number;
  uC: number;
  uV: number;
  /** Global scale on τw+ and τr to shorten the ventricular APD towards atrial values. */
  atrialScale: number;
}

export const FK_DEFAULT: FkParams = {
  tauVPlus: 3.33, tauV1Minus: 19.6, tauV2Minus: 1000, tauWPlus: 667, tauWMinus: 11,
  tauD: 0.25, tauO: 12.5, tauR: 33.33, tauSi: 29, k: 10, uCsi: 0.45, uC: 0.13, uV: 0.04,
  atrialScale: 0.94,
};

export class FentonKarma implements IonicModel {
  readonly id = 'fk' as const;
  readonly name = 'Fenton–Karma (3V)';
  readonly gates = 2;
  readonly recommendedDt = 0.05;
  constructor(readonly p: FkParams = FK_DEFAULT) {}

  restState(): [number, number, number] {
    return [0, 1, 1];
  }

  react(u: Float32Array, gv: Float32Array, gw: Float32Array, n: number, dt: number, apdScale: Float32Array, excitable: Uint8Array): void {
    const p = this.p;
    for (let i = 0; i < n; i++) {
      const x = u[i]!;
      if (!excitable[i]) {
        u[i] = x - (dt * x) / p.tauO;
        continue;
      }
      const s = apdScale[i]! * p.atrialScale;
      const vv = gv[i]!, ww = gw[i]!;
      const act = x >= p.uC;
      const jfi = act ? (-vv / p.tauD) * (1 - x) * (x - p.uC) : 0;
      const jso = act ? 1 / (p.tauR * s) : x / p.tauO;
      const jsi = (-ww / (2 * p.tauSi)) * (1 + Math.tanh(p.k * (x - p.uCsi)));
      const xn = x - dt * (jfi + jso + jsi);
      u[i] = xn < -0.2 ? -0.2 : xn > 1.3 ? 1.3 : xn;
      if (act) {
        gv[i] = vv * Math.exp(-dt / p.tauVPlus);
        gw[i] = ww * Math.exp(-dt / (p.tauWPlus * s));
      } else {
        const tvm = x >= p.uV ? p.tauV1Minus : p.tauV2Minus;
        gv[i] = 1 - (1 - vv) * Math.exp(-dt / tvm);
        gw[i] = 1 - (1 - ww) * Math.exp(-dt / p.tauWMinus);
      }
    }
  }

  wgsl(): string {
    const p = this.p;
    return /* wgsl */ `
fn react(u: f32, gv: f32, gw: f32, apd: f32, dt: f32, excitable: bool) -> vec3<f32> {
  if (!excitable) { return vec3<f32>(u - dt * u / ${f(p.tauO)}, gv, gw); }
  let s = apd * ${f(p.atrialScale)};
  let act = u >= ${f(p.uC)};
  var jfi = 0.0;
  var jso = u / ${f(p.tauO)};
  if (act) {
    jfi = (-gv / ${f(p.tauD)}) * (1.0 - u) * (u - ${f(p.uC)});
    jso = 1.0 / (${f(p.tauR)} * s);
  }
  let jsi = (-gw / (2.0 * ${f(p.tauSi)})) * (1.0 + tanh(${f(p.k)} * (u - ${f(p.uCsi)})));
  let un = clamp(u - dt * (jfi + jso + jsi), -0.2, 1.3);
  var nv = gv;
  var nw = gw;
  if (act) {
    nv = gv * exp(-dt / ${f(p.tauVPlus)});
    nw = gw * exp(-dt / (${f(p.tauWPlus)} * s));
  } else {
    var tvm = ${f(p.tauV2Minus)};
    if (u >= ${f(p.uV)}) { tvm = ${f(p.tauV1Minus)}; }
    nv = 1.0 - (1.0 - gv) * exp(-dt / tvm);
    nw = 1.0 - (1.0 - gw) * exp(-dt / ${f(p.tauWMinus)});
  }
  return vec3<f32>(un, nv, nw);
}`;
  }

  describe(): Record<string, number> {
    return { ...this.p };
  }
}
