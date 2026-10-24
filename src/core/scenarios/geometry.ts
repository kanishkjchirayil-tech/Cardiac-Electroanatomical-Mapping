import type { SurfaceMesh } from '../mesh/types';
import { vertexAdjacency, type Adjacency } from '../mesh/topology';
import { edgeDijkstra } from '../mesh/geodesic';
import { cross, dot, getV, normalize, perpendicular, sub } from '../math/vec3';

/** Mesh helpers for scenario construction (anatomy only; used to place ground truth). */
export class MeshTools {
  readonly adj: Adjacency;
  constructor(readonly mesh: SurfaceMesh) {
    this.adj = vertexAdjacency(mesh.indices, mesh.region.length);
  }

  /** Shortest edge path from vertex set A to vertex set B (list from B back to A). */
  path(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
    const { adj } = this;
    const dA = edgeDijkstra(this.mesh.positions, adj, A).distance;
    let cur = -1;
    for (const v of Array.from(B)) if (cur < 0 || dA[v]! < dA[cur]!) cur = v;
    const out = [cur];
    while (dA[cur]! > 0) {
      let nx = cur;
      for (let k = adj.offsets[cur]!; k < adj.offsets[cur + 1]!; k++) if (dA[adj.neighbors[k]!]! < dA[nx]!) nx = adj.neighbors[k]!;
      if (nx === cur) break;
      out.push(nx);
      cur = nx;
    }
    return out;
  }

  /** Grow a vertex set by `rings` edge rings. */
  dilate(vs: Iterable<number>, rings: number): Set<number> {
    const { adj } = this;
    let s = new Set(vs);
    for (let r = 0; r < rings; r++) {
      const t = new Set(s);
      for (const v of s) for (let k = adj.offsets[v]!; k < adj.offsets[v + 1]!; k++) t.add(adj.neighbors[k]!);
      s = t;
    }
    return s;
  }

  /** Angle of each vertex around the mitral annulus axis (radians). */
  mitralAngle(): (v: number) => number {
    const mv = this.mesh.anatomy!.mitral;
    const u = perpendicular(mv.normal), w = normalize(cross(mv.normal, u));
    return (v: number) => {
      const r = sub(getV(this.mesh.positions, v), mv.center);
      return Math.atan2(dot(r, w), dot(r, u));
    };
  }

  distance(a: number, b: number): number {
    const P = this.mesh.positions;
    return Math.hypot(P[3 * a]! - P[3 * b]!, P[3 * a + 1]! - P[3 * b + 1]!, P[3 * a + 2]! - P[3 * b + 2]!);
  }

  loop(label: string): number[] {
    const l = this.mesh.boundaryLoops.find((x) => x.label === label);
    if (!l) throw new Error(`The mesh has no ${label} opening`);
    return Array.from(l.vertices);
  }
}
