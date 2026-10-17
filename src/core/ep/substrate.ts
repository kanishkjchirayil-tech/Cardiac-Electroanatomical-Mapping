import { ValueNoise3 } from '../noise';
import { Rng } from '../rng';
import type { TissueGeometry } from './fem';

/**
 * Per-vertex tissue properties (MODEL.md §2.3). Fibrosis is realized as structural
 * conduction block: fibrotic nodes are inexcitable and electrically isolated (all incident
 * edges have zero conductance), or — for the interstitial pattern — individual edges oriented
 * across the local fibre direction are removed while the nodes stay excitable.
 */
export type FibrosisPattern = 'diffuse' | 'patchy' | 'interstitial';

export interface SubstrateSpec {
  seed: number;
  /** Per-vertex conductivity scale (1 = healthy). */
  conductivity?: Float32Array;
  /** Per-vertex multiplier on the ionic model's repolarization time constant. */
  apdScale?: Float32Array;
  /** Per-vertex fibrosis density 0..1 (expected fraction of affected nodes/edges). */
  fibrosisDensity?: Float32Array;
  fibrosisPattern?: FibrosisPattern;
  /** Feature size of patchy fibrosis, mm. */
  patchScale?: number;
  /** Per-vertex fibrosis transmurality 0..1 (fraction of wall thickness); used by EGM attenuation. */
  fibrosisDepth?: Float32Array;
  /** Per-vertex unit fibre direction (3·nV), required for the interstitial pattern. */
  fiberDir?: Float32Array;
}

export class Substrate {
  readonly nV: number;
  conductivity: Float32Array;
  apdScale: Float32Array;
  fibrosisDensity: Float32Array;
  fibrosisDepth: Float32Array;
  pattern: FibrosisPattern;
  /** Realized fibrotic (isolated, inexcitable) nodes. */
  fibroticNode: Uint8Array;
  /** Per-edge structural coupling 0..1 (interstitial removal, later lesions). */
  edgeScale: Float32Array;
  /** Per-vertex conductivity multiplier from ablation (M5); 1 = untouched. */
  lesionConductivity: Float32Array;
  /** Per-vertex inexcitable mask from ablation cores (M5). */
  lesionCore: Uint8Array;

  constructor(readonly geom: TissueGeometry, spec: SubstrateSpec) {
    const n = geom.nV;
    this.nV = n;
    this.conductivity = spec.conductivity ?? new Float32Array(n).fill(1);
    this.apdScale = spec.apdScale ?? new Float32Array(n).fill(1);
    this.fibrosisDensity = spec.fibrosisDensity ?? new Float32Array(n);
    this.fibrosisDepth = spec.fibrosisDepth ?? Float32Array.from(this.fibrosisDensity, (d) => Math.min(1, d > 0 ? 0.3 + 0.7 * d : 0));
    this.pattern = spec.fibrosisPattern ?? 'patchy';
    this.fibroticNode = new Uint8Array(n);
    this.edgeScale = new Float32Array(geom.edgeA.length).fill(1);
    this.lesionConductivity = new Float32Array(n).fill(1);
    this.lesionCore = new Uint8Array(n);
    this.realizeFibrosis(spec);
  }

  private realizeFibrosis(spec: SubstrateSpec): void {
    const g = this.geom;
    const rng = new Rng(spec.seed ^ 0xf1b2);
    const dens = this.fibrosisDensity;
    if (!dens.some((d) => d > 0)) return;
    if (this.pattern === 'diffuse') {
      for (let i = 0; i < this.nV; i++) if (rng.next() < dens[i]!) this.fibroticNode[i] = 1;
    } else if (this.pattern === 'patchy') {
      // Rank-uniformized fractal noise: a node is fibrotic where its noise percentile < local density,
      // giving clustered patches whose local area fraction tracks the density field.
      const noise = new ValueNoise3(spec.seed ^ 0x9a7c);
      const scale = spec.patchScale ?? 6;
      const P = g.positions;
      const vals = Array.from({ length: this.nV }, (_, i) => noise.fbm(P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!, scale, 2));
      const order = vals.map((_, i) => i).sort((a, b) => vals[a]! - vals[b]!);
      const rank = new Float32Array(this.nV);
      order.forEach((v, r) => (rank[v] = (r + 0.5) / this.nV));
      for (let i = 0; i < this.nV; i++) if (rank[i]! < dens[i]!) this.fibroticNode[i] = 1;
    } else {
      const fib = spec.fiberDir;
      if (!fib) throw new Error('Interstitial fibrosis needs a fibre direction field');
      const P = g.positions;
      for (let e = 0; e < g.edgeA.length; e++) {
        const a = g.edgeA[e]!, b = g.edgeB[e]!;
        const d = 0.5 * (dens[a]! + dens[b]!);
        if (d <= 0) continue;
        const ex = P[3 * b]! - P[3 * a]!, ey = P[3 * b + 1]! - P[3 * a + 1]!, ez = P[3 * b + 2]! - P[3 * a + 2]!;
        const el = Math.hypot(ex, ey, ez) || 1;
        const fx = fib[3 * a]! + fib[3 * b]!, fy = fib[3 * a + 1]! + fib[3 * b + 1]!, fz = fib[3 * a + 2]! + fib[3 * b + 2]!;
        const fl = Math.hypot(fx, fy, fz) || 1;
        const cos = (ex * fx + ey * fy + ez * fz) / (el * fl);
        // Transverse edges are preferentially uncoupled; E[2 sin²φ] = 1 for isotropic edge directions.
        const p = Math.min(1, 2 * d * (1 - cos * cos));
        if (rng.next() < p) this.edgeScale[e] = 0;
      }
    }
  }

  /** Inexcitable vertices: fibrotic nodes and lesion cores. */
  excitable(): Uint8Array {
    const out = new Uint8Array(this.nV);
    for (let i = 0; i < this.nV; i++) out[i] = this.fibroticNode[i] || this.lesionCore[i] ? 0 : 1;
    return out;
  }

  /** Per-edge diffusivity D_e = D0 · harmonic-mean(σ_a, σ_b) · edgeScale_e, zero at isolated nodes. */
  edgeDiffusivity(D0: number): Float32Array {
    const g = this.geom;
    const out = new Float32Array(g.edgeA.length);
    const exc = this.excitable();
    for (let e = 0; e < out.length; e++) {
      const a = g.edgeA[e]!, b = g.edgeB[e]!;
      if (!exc[a] || !exc[b]) continue;
      const sa = this.conductivity[a]! * this.lesionConductivity[a]!;
      const sb = this.conductivity[b]! * this.lesionConductivity[b]!;
      const hm = sa + sb > 0 ? (2 * sa * sb) / (sa + sb) : 0;
      out[e] = D0 * hm * this.edgeScale[e]!;
    }
    return out;
  }

  /** Fraction of nodes realized as fibrotic, and of edges removed. */
  stats(): { fibroticNodeFraction: number; removedEdgeFraction: number } {
    let n = 0, e = 0;
    this.fibroticNode.forEach((x) => (n += x));
    this.edgeScale.forEach((x) => (e += x === 0 ? 1 : 0));
    return { fibroticNodeFraction: n / this.nV, removedEdgeFraction: e / Math.max(1, this.edgeScale.length) };
  }
}
