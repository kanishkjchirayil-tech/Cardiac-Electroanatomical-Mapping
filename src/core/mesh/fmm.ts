import { MinHeap } from './geodesic';

/**
 * Reusable, truncated fast-marching geodesic distance on a triangle mesh (Kimmel & Sethian
 * 1998) with unit speed. Precomputes vertex→triangle incidence once; each query touches only the
 * vertices within `maxDistance`, so per-point local distance fields are cheap.
 */
export class GeodesicFmm {
  private readonly deg: Uint32Array;
  private readonly vtri: Uint32Array;
  private readonly T: Float64Array;
  private readonly state: Uint8Array;

  constructor(readonly positions: Float32Array, readonly indices: Uint32Array) {
    const nV = positions.length / 3;
    this.deg = new Uint32Array(nV + 1);
    for (let i = 0; i < indices.length; i++) this.deg[indices[i]! + 1]!++;
    for (let i = 0; i < nV; i++) this.deg[i + 1]! += this.deg[i]!;
    this.vtri = new Uint32Array(indices.length);
    const fill = this.deg.slice(0, nV);
    for (let t = 0; t < indices.length / 3; t++) for (let k = 0; k < 3; k++) this.vtri[fill[indices[3 * t + k]!]!++] = t;
    this.T = new Float64Array(nV).fill(Infinity);
    this.state = new Uint8Array(nV);
  }

  /**
   * Distances from a point p lying near vertex `seed` (its 2-ring is initialized with straight-line
   * distances to p) out to maxDistance. Returns touched vertices and their distances.
   */
  local(seed: number, p: ArrayLike<number>, maxDistance: number): { idx: Uint32Array; d: Float32Array } {
    const { T, state, deg, vtri, indices: I, positions: P } = this;
    const touched: number[] = [];
    const heap = new MinHeap();
    const set = (v: number, t: number) => {
      if (t >= T[v]!) return;
      if (T[v] === Infinity) touched.push(v);
      T[v] = t;
      state[v] = 1;
      heap.push(t, v);
    };
    const eu = (v: number) => Math.hypot(P[3 * v]! - p[0]!, P[3 * v + 1]! - p[1]!, P[3 * v + 2]! - p[2]!);
    set(seed, eu(seed));
    let ring = [seed];
    const seen = new Set(ring);
    for (let r = 0; r < 2; r++) {
      const next: number[] = [];
      for (const v of ring) for (let k = deg[v]!; k < deg[v + 1]!; k++) for (let j = 0; j < 3; j++) {
        const u = I[3 * vtri[k]! + j]!;
        if (!seen.has(u)) { seen.add(u); next.push(u); set(u, eu(u)); }
      }
      ring = next;
    }
    while (heap.size) {
      const [t, v] = heap.pop();
      if (state[v] === 2 || t > T[v]!) continue;
      if (t > maxDistance) break;
      state[v] = 2;
      for (let k = deg[v]!; k < deg[v + 1]!; k++) {
        const tri = vtri[k]!;
        for (let j = 0; j < 3; j++) {
          const u = I[3 * tri + j]!;
          if (state[u] === 2) continue;
          const nt = this.update(u);
          if (nt < T[u]!) set(u, nt);
        }
      }
    }
    const idx: number[] = [], d: number[] = [];
    for (const v of touched) {
      if (T[v]! <= maxDistance) { idx.push(v); d.push(T[v]!); }
      T[v] = Infinity;
      state[v] = 0;
    }
    return { idx: Uint32Array.from(idx), d: Float32Array.from(d) };
  }

  /** Same triangle update as the eikonal solver, with F = 1. */
  private update(c: number): number {
    const { T, state, deg, vtri, indices: I, positions: P } = this;
    let best = T[c]!;
    const cx = P[3 * c]!, cy = P[3 * c + 1]!, cz = P[3 * c + 2]!;
    for (let k = deg[c]!; k < deg[c + 1]!; k++) {
      const t = vtri[k]!;
      let a = I[3 * t]!, b = I[3 * t + 1]!;
      const third = I[3 * t + 2]!;
      if (a === c) a = third;
      else if (b === c) b = third;
      const ta = state[a] === 2 ? T[a]! : Infinity, tb = state[b] === 2 ? T[b]! : Infinity;
      const e1x = P[3 * a]! - cx, e1y = P[3 * a + 1]! - cy, e1z = P[3 * a + 2]! - cz;
      const e2x = P[3 * b]! - cx, e2y = P[3 * b + 1]! - cy, e2z = P[3 * b + 2]! - cz;
      const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
      if (ta < Infinity) best = Math.min(best, ta + l1);
      if (tb < Infinity) best = Math.min(best, tb + l2);
      if (ta === Infinity || tb === Infinity) continue;
      const g11 = l1 * l1, g22 = l2 * l2, g12 = e1x * e2x + e1y * e2y + e1z * e2z;
      const det = g11 * g22 - g12 * g12;
      if (det <= 1e-12) continue;
      const q11 = g22 / det, q22 = g11 / det, q12 = -g12 / det;
      const A = q11 + q22 + 2 * q12;
      const B = ta * (q11 + q12) + tb * (q22 + q12);
      const C = q11 * ta * ta + 2 * q12 * ta * tb + q22 * tb * tb - 1;
      const disc = B * B - A * C;
      if (disc < 0) continue;
      const x = (B + Math.sqrt(disc)) / A;
      if (x < Math.max(ta, tb)) continue;
      const d1 = ta - x, d2 = tb - x;
      if (q11 * d1 + q12 * d2 <= 0 && q12 * d1 + q22 * d2 <= 0) best = Math.min(best, x);
    }
    return best;
  }
}
