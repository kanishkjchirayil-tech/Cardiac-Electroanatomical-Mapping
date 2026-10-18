import { V_PEAK_MV, V_REST_MV } from '../ep/ionic';

/**
 * Volume-conductor lead fields for extracellular potentials (MODEL.md §3.1).
 *
 * In an infinite homogeneous conductor the extracellular potential at x is
 *   φ(x) = −K ∫ ∇Vm(y) · ∇_y(1/|x − y|) dV,   K = σ_i / (4π σ_e),
 * a sum of current dipoles p = −σ_i ∇Vm. On the triangulated surface each triangle carries a
 * constant ∇Vm (P1 interpolation) and a source volume A·t (area × viable wall thickness) placed at
 * mid-wall, y = centroid + n·t/2 (n points out of the blood pool). Because ∇Vm is linear in the
 * vertex potentials, φ(x) = Σ_k c_k(x) v_k: a sparse lead-field vector per electrode.
 */
export interface SourceGeometry {
  nV: number;
  indices: Uint32Array;
  /** Mid-wall source point per triangle (3·nF). */
  center: Float32Array;
  /** Basis-function gradients per triangle corner (9·nF): ∇φ_a, ∇φ_b, ∇φ_c (1/mm). */
  basisGrad: Float32Array;
  /** Effective source volume per triangle (mm³): area × viable thickness × coupling. */
  volume: Float32Array;
}

export interface SourceOptions {
  /** Wall thickness per vertex (mm). */
  thickness: Float32Array;
  /** Fraction of the wall replaced by fibrosis per vertex (0..1); reduces the viable source. */
  fibrosisDepth?: Float32Array;
  /** Inexcitable vertices (fibrotic nodes, lesion cores) carry no impressed current. */
  excitable?: Uint8Array;
  /** Per-vertex extra source scale (lesion border zones, M5). */
  sourceScale?: Float32Array;
}

export function buildSourceGeometry(positions: Float32Array, indices: Uint32Array, opts: SourceOptions): SourceGeometry {
  const nF = indices.length / 3;
  const center = new Float32Array(3 * nF);
  const basisGrad = new Float32Array(9 * nF);
  const volume = new Float32Array(nF);
  const P = positions;
  for (let f = 0; f < nF; f++) {
    const ia = indices[3 * f]!, ib = indices[3 * f + 1]!, ic = indices[3 * f + 2]!;
    const ax = P[3 * ia]!, ay = P[3 * ia + 1]!, az = P[3 * ia + 2]!;
    const e1x = P[3 * ib]! - ax, e1y = P[3 * ib + 1]! - ay, e1z = P[3 * ib + 2]! - az;
    const e2x = P[3 * ic]! - ax, e2y = P[3 * ic + 1]! - ay, e2z = P[3 * ic + 2]! - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const n2 = nx * nx + ny * ny + nz * nz;
    const nl = Math.sqrt(n2);
    if (nl < 1e-12) continue;
    const area = 0.5 * nl;
    // Gradient of the barycentric basis: ∇φ_a = (n × (c − b)) / |n|², etc.
    const corners = [ia, ib, ic];
    for (let k = 0; k < 3; k++) {
      const p = corners[(k + 1) % 3]!, q = corners[(k + 2) % 3]!;
      const ex = P[3 * q]! - P[3 * p]!, ey = P[3 * q + 1]! - P[3 * p + 1]!, ez = P[3 * q + 2]! - P[3 * p + 2]!;
      basisGrad[9 * f + 3 * k] = (ny * ez - nz * ey) / n2;
      basisGrad[9 * f + 3 * k + 1] = (nz * ex - nx * ez) / n2;
      basisGrad[9 * f + 3 * k + 2] = (nx * ey - ny * ex) / n2;
    }
    let t = 0, viable = 0, scale = 0, exc = 0;
    for (const v of corners) {
      const tv = opts.thickness[v]!;
      t += tv / 3;
      viable += (tv * (1 - (opts.fibrosisDepth?.[v] ?? 0))) / 3;
      scale += (opts.sourceScale?.[v] ?? 1) / 3;
      exc += opts.excitable ? opts.excitable[v]! : 1;
    }
    // A triangle touching an inexcitable node has no intracellular coupling across it.
    volume[f] = exc === 3 ? area * viable * scale : 0;
    const cx = (3 * ax + e1x + e2x) / 3, cy = (3 * ay + e1y + e2y) / 3, cz = (3 * az + e1z + e2z) / 3;
    center[3 * f] = cx + (nx / nl) * (t / 2);
    center[3 * f + 1] = cy + (ny / nl) * (t / 2);
    center[3 * f + 2] = cz + (nz / nl) * (t / 2);
  }
  return { nV: positions.length / 3, indices, center, basisGrad, volume };
}

/** Sparse lead field: φ = Σ w[i] · v[idx[i]] (mV), with v the normalized transmembrane variable. */
export interface LeadField {
  idx: Uint32Array;
  w: Float32Array;
}

export interface LeadFieldOptions {
  /** K = σ_i / (4π σ_e) (dimensionless). */
  K: number;
  /** Only triangles closer than this (mm) contribute; Infinity for body-surface leads. */
  cutoff: number;
}

/** σ_i ≈ 0.17 S/m (bulk intracellular), σ_blood ≈ 0.7 S/m → K ≈ 0.019 for intracardiac electrodes. */
export const K_BLOOD = 0.17 / (4 * Math.PI * 0.7);
export const DEFAULT_INTRACARDIAC: LeadFieldOptions = { K: K_BLOOD, cutoff: 30 };

/** Scale from normalized v to millivolts in the gradient (the resting offset has no gradient). */
const MV_PER_V = V_PEAK_MV - V_REST_MV;

export function buildLeadField(src: SourceGeometry, x: [number, number, number], opts: LeadFieldOptions, scratch?: Float64Array): LeadField {
  const acc = scratch && scratch.length >= src.nV ? scratch : new Float64Array(src.nV);
  const touched: number[] = [];
  const nF = src.volume.length;
  const c2 = opts.cutoff * opts.cutoff;
  const I = src.indices;
  for (let f = 0; f < nF; f++) {
    const vol = src.volume[f]!;
    if (vol === 0) continue;
    const dx = x[0] - src.center[3 * f]!, dy = x[1] - src.center[3 * f + 1]!, dz = x[2] - src.center[3 * f + 2]!;
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 > c2) continue;
    const r3 = r2 * Math.sqrt(r2);
    // ∇_y(1/|x − y|) = (x − y)/r³; φ = −K·vol·∇Vm·(x − y)/r³.
    const s = (-opts.K * vol * MV_PER_V) / r3;
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k]!;
      const g = src.basisGrad[9 * f + 3 * k]! * dx + src.basisGrad[9 * f + 3 * k + 1]! * dy + src.basisGrad[9 * f + 3 * k + 2]! * dz;
      if (acc[v] === 0) touched.push(v);
      acc[v] = acc[v]! + s * g;
    }
  }
  touched.sort((a, b) => a - b);
  const idx = Uint32Array.from(touched);
  const w = Float32Array.from(touched, (v) => acc[v]!);
  for (const v of touched) acc[v] = 0;
  return { idx, w };
}

export function applyLeadField(lf: LeadField, v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < lf.idx.length; i++) s += lf.w[i]! * v[lf.idx[i]!]!;
  return s;
}
