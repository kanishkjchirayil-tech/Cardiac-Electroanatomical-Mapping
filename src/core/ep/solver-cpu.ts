import { buildDiffusion, stableDiffusionDt, type DiffusionOperator, type TissueGeometry } from './fem';
import type { IonicModel } from './ionic';
import { ACT_THRESHOLD, REPOL_THRESHOLD, type ActivationRecord, type BackendInit, type SolverBackend } from './backend';
import { MAX_STIM_SITES } from './stimulus';

/**
 * Typed-array CPU backend (runs in a Web Worker in the app, directly in Node for tests).
 * Godunov operator splitting per time step dt:
 *   1. diffusion: n_sub explicit Euler substeps of dV/dt = L V (n_sub chosen for stability),
 *   2. stimulus current,
 *   3. reaction: ionic model update (Rush–Larsen gates).
 */
export class CpuBackend implements SolverBackend {
  readonly kind = 'cpu' as const;
  readonly nV: number;
  diffusionSubsteps = 1;
  private readonly geom: TissueGeometry;
  private readonly model: IonicModel;
  private readonly dt: number;
  private op!: DiffusionOperator;
  private v: Float32Array;
  private tmp: Float32Array;
  private vPrev: Float32Array;
  private g0: Float32Array;
  private g1: Float32Array;
  private apd: Float32Array;
  private exc: Uint8Array;
  private siteOf: Int32Array;
  private act: ActivationRecord;

  constructor(init: BackendInit) {
    this.geom = init.geom;
    this.model = init.model;
    this.dt = init.dt;
    const n = (this.nV = init.geom.nV);
    const rest = init.model.restState();
    this.v = new Float32Array(n).fill(rest[0]);
    this.g0 = new Float32Array(n).fill(rest[1]);
    this.g1 = new Float32Array(n).fill(rest[2]);
    this.tmp = new Float32Array(n);
    this.vPrev = new Float32Array(n);
    this.apd = init.apdScale;
    this.exc = init.excitable;
    this.siteOf = init.siteOf;
    this.act = { last: new Float32Array(n).fill(-Infinity), prev: new Float32Array(n).fill(-Infinity), repol: new Float32Array(n).fill(-Infinity), count: new Uint32Array(n) };
    this.setEdgeDiffusivity(init.edgeD);
  }

  setEdgeDiffusivity(edgeD: Float32Array): void {
    this.op = buildDiffusion(this.geom, edgeD);
    this.diffusionSubsteps = Math.max(1, Math.ceil(this.dt / stableDiffusionDt(this.op)));
  }

  setVertexParams(apdScale: Float32Array, excitable: Uint8Array): void {
    this.apd = apdScale;
    this.exc = excitable;
  }

  setSiteMap(siteOf: Int32Array): void {
    this.siteOf = siteOf;
  }

  step(nSteps: number, t0: number, amps: Float32Array): void {
    const n = this.nV, dt = this.dt;
    const nSub = this.diffusionSubsteps, dts = dt / nSub;
    const { rowPtr, col, w } = this.op;
    const act = this.act;
    for (let s = 0; s < nSteps; s++) {
      this.vPrev.set(this.v);
      for (let k = 0; k < nSub; k++) {
        const v = this.v, out = this.tmp;
        for (let i = 0; i < n; i++) {
          const vi = v[i]!;
          let acc = 0;
          for (let j = rowPtr[i]!, end = rowPtr[i + 1]!; j < end; j++) acc += w[j]! * (v[col[j]!]! - vi);
          out[i] = vi + dts * acc;
        }
        this.tmp = v;
        this.v = out;
      }
      const ampOff = s * MAX_STIM_SITES;
      let anyStim = false;
      for (let k = 0; k < MAX_STIM_SITES; k++) if (amps[ampOff + k]! !== 0) anyStim = true;
      if (anyStim) {
        for (let i = 0; i < n; i++) {
          const site = this.siteOf[i]!;
          if (site >= 0) this.v[i] = this.v[i]! + dt * amps[ampOff + site]!;
        }
      }
      this.model.react(this.v, this.g0, this.g1, n, dt, this.apd, this.exc);
      // Activation / repolarization crossings, linearly interpolated within the step.
      const tStart = t0 + s * dt;
      const v = this.v, vp = this.vPrev;
      for (let i = 0; i < n; i++) {
        const a = vp[i]!, b = v[i]!;
        if (a < ACT_THRESHOLD && b >= ACT_THRESHOLD) {
          act.prev[i] = act.last[i]!;
          act.last[i] = tStart + (dt * (ACT_THRESHOLD - a)) / (b - a);
          act.count[i]!++;
        } else if (a > REPOL_THRESHOLD && b <= REPOL_THRESHOLD) {
          act.repol[i] = tStart + (dt * (a - REPOL_THRESHOLD)) / (a - b);
        }
      }
    }
  }

  readV(): Float32Array {
    return this.v.slice();
  }

  readActivation(): ActivationRecord {
    const a = this.act;
    return { last: a.last.slice(), prev: a.prev.slice(), repol: a.repol.slice(), count: a.count.slice() };
  }

  setState(v: Float32Array, g0?: Float32Array, g1?: Float32Array): void {
    this.v.set(v);
    if (g0) this.g0.set(g0);
    if (g1) this.g1.set(g1);
  }

  getState(): { v: Float32Array; g0: Float32Array; g1: Float32Array } {
    return { v: this.v.slice(), g0: this.g0.slice(), g1: this.g1.slice() };
  }

  resetActivation(): void {
    this.act.last.fill(-Infinity);
    this.act.prev.fill(-Infinity);
    this.act.repol.fill(-Infinity);
    this.act.count.fill(0);
  }

  dispose(): void {}
}
