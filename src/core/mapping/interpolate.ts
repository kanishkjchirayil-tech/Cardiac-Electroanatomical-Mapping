import { GeodesicFmm } from '../mesh/fmm';
import type { Vec3 } from '../math/vec3';

/**
 * Geodesic inverse-distance interpolation of point values onto mesh vertices (MODEL.md §4.4):
 *   value(i) = Σ_p w_p v_p / Σ_p w_p,  w_p = 1 / (d_g(i, p) + d0)^power,
 * over points with geodesic distance d_g ≤ fill threshold; vertices with no such point are
 * unmapped (NaN). Each point's local distance field is computed once by truncated fast marching
 * from the point's projection onto the surface and cached.
 */
export interface InterpPoint {
  id: number;
  vertex: number;
  location: Vec3;
  value: number;
}

export interface InterpOptions {
  fillThreshold: number;
  power?: number;
  /** Softening distance (mm) so a vertex at a point is not infinitely weighted. */
  d0?: number;
}

export class MapInterpolator {
  private readonly fmm: GeodesicFmm;
  private readonly cache = new Map<number, { radius: number; idx: Uint32Array; d: Float32Array }>();
  readonly nV: number;

  constructor(readonly positions: Float32Array, readonly normals: Float32Array, indices: Uint32Array) {
    this.fmm = new GeodesicFmm(positions, indices);
    this.nV = positions.length / 3;
  }

  /** Local geodesic distance field of a point (cached; recomputed if a larger radius is needed). */
  field(p: Omit<InterpPoint, 'value'>, radius: number): { idx: Uint32Array; d: Float32Array } {
    const c = this.cache.get(p.id);
    if (c && c.radius >= radius) return c;
    const v = p.vertex, P = this.positions, N = this.normals;
    // Project the catheter location onto the tangent plane of its nearest vertex.
    const rel = [p.location[0] - P[3 * v]!, p.location[1] - P[3 * v + 1]!, p.location[2] - P[3 * v + 2]!];
    const h = rel[0]! * N[3 * v]! + rel[1]! * N[3 * v + 1]! + rel[2]! * N[3 * v + 2]!;
    const proj = [p.location[0] - h * N[3 * v]!, p.location[1] - h * N[3 * v + 1]!, p.location[2] - h * N[3 * v + 2]!];
    const f = { radius, ...this.fmm.local(v, proj, radius) };
    this.cache.set(p.id, f);
    return f;
  }

  forget(id: number): void {
    this.cache.delete(id);
  }

  interpolate(points: InterpPoint[], o: InterpOptions): Float32Array {
    const power = o.power ?? 2, d0 = o.d0 ?? 0.5;
    const num = new Float64Array(this.nV), den = new Float64Array(this.nV);
    for (const p of points) {
      if (!Number.isFinite(p.value)) continue;
      const f = this.field(p, o.fillThreshold);
      for (let k = 0; k < f.idx.length; k++) {
        const d = f.d[k]!;
        if (d > o.fillThreshold) continue;
        const w = 1 / Math.pow(d + d0, power);
        num[f.idx[k]!] += w * p.value;
        den[f.idx[k]!] += w;
      }
    }
    const out = new Float32Array(this.nV);
    for (let i = 0; i < this.nV; i++) out[i] = den[i]! > 0 ? num[i]! / den[i]! : NaN;
    return out;
  }
}
