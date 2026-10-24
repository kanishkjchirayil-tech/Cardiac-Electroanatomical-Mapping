import type { SurfaceMesh } from '../mesh/types';
import type { TissueGeometry } from '../ep/fem';
import { Region, type PvName } from '../mesh/regions';

/**
 * Ground-truth conduction topology (MODEL.md §6.3). These checks read the hidden tissue state and
 * are used only for scenario success criteria, the end-of-case report and the teacher view.
 *
 * Conduction is modelled on the mesh graph: an edge conducts when both its vertices are excitable
 * and its diffusivity is non-zero (lesion cores and fibrotic nodes are inexcitable; partial-
 * thickness lesions conduct).
 */
export class ConductionGraph {
  private readonly off: Uint32Array;
  private readonly nbr: Uint32Array;

  constructor(readonly geom: TissueGeometry, edgeD: Float32Array, readonly excitable: Uint8Array) {
    const n = geom.nV;
    const deg = new Uint32Array(n + 1);
    const ok = (e: number) => edgeD[e]! > 0 && excitable[geom.edgeA[e]!] && excitable[geom.edgeB[e]!];
    for (let e = 0; e < geom.edgeA.length; e++) if (ok(e)) { deg[geom.edgeA[e]! + 1]!++; deg[geom.edgeB[e]! + 1]!++; }
    for (let i = 0; i < n; i++) deg[i + 1]! += deg[i]!;
    this.off = deg;
    this.nbr = new Uint32Array(deg[n]!);
    const fill = deg.slice(0, n);
    for (let e = 0; e < geom.edgeA.length; e++) {
      if (!ok(e)) continue;
      const a = geom.edgeA[e]!, b = geom.edgeB[e]!;
      this.nbr[fill[a]!++] = b;
      this.nbr[fill[b]!++] = a;
    }
  }

  /** Vertices reachable from `sources` through conducting edges. */
  reachable(sources: ArrayLike<number>): Uint8Array {
    const seen = new Uint8Array(this.geom.nV);
    const stack: number[] = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]!;
      if (this.excitable[s] && !seen[s]) { seen[s] = 1; stack.push(s); }
    }
    while (stack.length) {
      const v = stack.pop()!;
      for (let k = this.off[v]!; k < this.off[v + 1]!; k++) {
        const w = this.nbr[k]!;
        if (!seen[w]) { seen[w] = 1; stack.push(w); }
      }
    }
    return seen;
  }
}

const PV_REGION: Record<PvName, Region> = { LSPV: Region.LSPV, LIPV: Region.LIPV, RSPV: Region.RSPV, RIPV: Region.RIPV };

/** Fraction of a vein's excitable sleeve vertices that the LA body can reach (0 = isolated). */
export function pvConnectedFraction(mesh: SurfaceMesh, body: Uint8Array, excitable: Uint8Array, pv: PvName): number {
  let tot = 0, hit = 0;
  mesh.region.forEach((r, i) => {
    if (r !== PV_REGION[pv] || !excitable[i]) return;
    tot++;
    if (body[i]) hit++;
  });
  return tot ? hit / tot : 0;
}

/**
 * Barrier components: inexcitable vertices, vertices on mesh openings, and excitable vertices cut
 * off from the LA body (isolated islands) are "barrier"; they are joined along mesh edges. A
 * line of block between two openings exists exactly when both openings fall in one component,
 * because any conducting path between the two sides would have to cross that chain of vertices.
 */
export function barrierComponents(mesh: SurfaceMesh, body: Uint8Array): Int32Array {
  const n = mesh.region.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  };
  const barrier = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!body[i]) barrier[i] = 1;
  for (const l of mesh.boundaryLoops) for (const v of l.vertices) barrier[v] = 1;
  const I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = I[t + k]!, b = I[t + ((k + 1) % 3)]!;
      if (barrier[a] && barrier[b]) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (barrier[i]) comp[i] = find(i);
  return comp;
}

/** Component id of an opening (boundary loop label), or −1. */
export function openingComponent(mesh: SurfaceMesh, comp: Int32Array, label: string): number {
  const l = mesh.boundaryLoops.find((x) => x.label === label);
  return l && l.vertices.length ? comp[l.vertices[0]!]! : -1;
}
