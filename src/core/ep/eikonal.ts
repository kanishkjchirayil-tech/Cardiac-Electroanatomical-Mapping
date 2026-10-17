import { MinHeap } from '../mesh/geodesic';

/**
 * Fast marching on a triangulated surface (Kimmel & Sethian 1998) for the eikonal equation
 * |∇T| = 1/F, where F is the local conduction velocity (mm/ms). MODEL.md §2.6.
 *
 * Triangle update: with known T_A, T_B and unknown C, the linear interpolant's gradient g in the
 * triangle plane satisfies T_A = T_C + g·e1, T_B = T_C + g·e2 (e1 = A−C, e2 = B−C). Writing
 * δ = (T_A, T_B) − T_C·1 and Q = (EᵀE)⁻¹, |g|² = δᵀQδ = 1/F² gives a quadratic in T_C. The update
 * is accepted only if the characteristic arrives from inside the triangle (Qδ ≤ 0 componentwise)
 * and T_C ≥ max(T_A, T_B); otherwise the edge (Dijkstra-like) updates are used.
 */
export interface EikonalSource {
  vertex: number;
  t0: number;
}

export function fastMarching(
  positions: Float32Array,
  indices: Uint32Array,
  speed: Float32Array,
  sources: EikonalSource[],
): Float32Array {
  const nV = positions.length / 3;
  const T = new Float64Array(nV).fill(Infinity);
  const state = new Uint8Array(nV); // 0 far, 1 trial, 2 accepted
  // Vertex → incident triangles (CSR).
  const deg = new Uint32Array(nV + 1);
  for (let i = 0; i < indices.length; i++) deg[indices[i]! + 1]!++;
  for (let i = 0; i < nV; i++) deg[i + 1]! += deg[i]!;
  const vtri = new Uint32Array(indices.length);
  const fill = deg.slice(0, nV);
  for (let t = 0; t < indices.length / 3; t++) for (let k = 0; k < 3; k++) vtri[fill[indices[3 * t + k]!]!++] = t;

  const heap = new MinHeap();
  const P = positions;
  // Source initialization: vertices within two rings of each source get the straight-line time,
  // which removes most of the first-order error that otherwise originates at a point source.
  const seed = (v: number, t: number) => {
    if (speed[v]! <= 0 || t >= T[v]!) return;
    T[v] = t;
    state[v] = 1;
    heap.push(t, v);
  };
  for (const s of sources) {
    if (speed[s.vertex]! <= 0) continue;
    seed(s.vertex, s.t0);
    let ring = new Set<number>([s.vertex]);
    const seen = new Set<number>(ring);
    for (let r = 0; r < 2; r++) {
      const next = new Set<number>();
      for (const v of ring) {
        for (let k = deg[v]!; k < deg[v + 1]!; k++) {
          const tri = vtri[k]!;
          for (let j = 0; j < 3; j++) {
            const u = indices[3 * tri + j]!;
            if (seen.has(u) || speed[u]! <= 0) continue;
            seen.add(u);
            next.add(u);
          }
        }
      }
      for (const u of next) {
        const d = Math.hypot(P[3 * u]! - P[3 * s.vertex]!, P[3 * u + 1]! - P[3 * s.vertex + 1]!, P[3 * u + 2]! - P[3 * s.vertex + 2]!);
        seed(u, s.t0 + d / (0.5 * (speed[u]! + speed[s.vertex]!)));
      }
      ring = next;
    }
  }
  const update = (c: number): number => {
    const F = speed[c]!;
    if (F <= 0) return Infinity;
    let best = T[c]!;
    const cx = P[3 * c]!, cy = P[3 * c + 1]!, cz = P[3 * c + 2]!;
    for (let k = deg[c]!; k < deg[c + 1]!; k++) {
      const t = vtri[k]!;
      let a = indices[3 * t]!, b = indices[3 * t + 1]!;
      const third = indices[3 * t + 2]!;
      if (a === c) a = third;
      else if (b === c) b = third;
      const ta = state[a] === 2 ? T[a]! : Infinity;
      const tb = state[b] === 2 ? T[b]! : Infinity;
      const e1x = P[3 * a]! - cx, e1y = P[3 * a + 1]! - cy, e1z = P[3 * a + 2]! - cz;
      const e2x = P[3 * b]! - cx, e2y = P[3 * b + 1]! - cy, e2z = P[3 * b + 2]! - cz;
      const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
      if (ta < Infinity) best = Math.min(best, ta + l1 / F);
      if (tb < Infinity) best = Math.min(best, tb + l2 / F);
      if (ta === Infinity || tb === Infinity) continue;
      // Gram matrix G = EᵀE and its inverse Q.
      const g11 = l1 * l1, g22 = l2 * l2, g12 = e1x * e2x + e1y * e2y + e1z * e2z;
      const det = g11 * g22 - g12 * g12;
      if (det <= 1e-12) continue;
      const q11 = g22 / det, q22 = g11 / det, q12 = -g12 / det;
      // Quadratic in x = T_C:  a x² − 2 b x + c = 0.
      const A = q11 + q22 + 2 * q12;
      const B = ta * (q11 + q12) + tb * (q22 + q12);
      const C = q11 * ta * ta + 2 * q12 * ta * tb + q22 * tb * tb - 1 / (F * F);
      const disc = B * B - A * C;
      if (disc < 0) continue;
      const x = (B + Math.sqrt(disc)) / A;
      if (x < Math.max(ta, tb)) continue;
      const d1 = ta - x, d2 = tb - x;
      const al1 = q11 * d1 + q12 * d2, al2 = q12 * d1 + q22 * d2;
      if (al1 <= 0 && al2 <= 0) best = Math.min(best, x);
    }
    return best;
  };

  while (heap.size > 0) {
    const [t, v] = heap.pop();
    if (state[v] === 2 || t > T[v]!) continue;
    state[v] = 2;
    for (let k = deg[v]!; k < deg[v + 1]!; k++) {
      const tri = vtri[k]!;
      for (let j = 0; j < 3; j++) {
        const u = indices[3 * tri + j]!;
        if (state[u] === 2) continue;
        const nt = update(u);
        if (nt < T[u]!) {
          T[u] = nt;
          state[u] = 1;
          heap.push(nt, u);
        }
      }
    }
  }
  return Float32Array.from(T);
}

/**
 * Normalized action-potential template v(τ) sampled every 0.5 ms from a single-cell run of the
 * active ionic model; used to synthesize Vm(t) = template(t − T_i) in eikonal mode.
 */
export class ApTemplate {
  constructor(readonly samples: Float32Array, readonly step: number, readonly upstrokeOffset: number) {}

  /** v at time τ (ms) after the activation time (v crossing 0.5). */
  at(tau: number): number {
    const x = (tau + this.upstrokeOffset) / this.step;
    if (x < 0 || x >= this.samples.length - 1) return 0;
    const i = Math.floor(x), f = x - i;
    return this.samples[i]! * (1 - f) + this.samples[i + 1]! * f;
  }
}
