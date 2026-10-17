import { cross, dot, len, normalize, sub, type Vec3 } from '../math/vec3';
import { edgeKey } from './topology';

/**
 * Isotropic surface remeshing (Botsch & Kobbelt 2004): repeated edge split / collapse /
 * valence-equalizing flips / tangential relaxation, with vertices re-projected onto the
 * target surface after every move. Boundary vertices carry a curve id and are kept on that
 * boundary curve. A final pass of (near-planar) Delaunay flips improves cotangent weights.
 */
export interface RemeshTarget {
  projectSurface(p: Vec3): Vec3;
  projectCurve(p: Vec3, curve: number): Vec3;
  /** Outward unit normal of the target surface near p. */
  normal(p: Vec3): Vec3;
}

export class DynMesh {
  P: number[];
  /** 3 entries per triangle; T[3t] === -1 marks a deleted triangle. */
  T: number[];
  vt: number[][];
  /** Boundary curve id per vertex (-1 = interior). */
  curve: number[];

  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    this.P = Array.from(positions);
    this.T = Array.from(indices);
    const nV = this.P.length / 3;
    this.vt = Array.from({ length: nV }, () => []);
    this.curve = new Array(nV).fill(-1);
    for (let t = 0; t < this.T.length / 3; t++) for (let e = 0; e < 3; e++) this.vt[this.T[3 * t + e]!]!.push(t);
  }

  get vertexCount(): number {
    return this.P.length / 3;
  }

  get triangleCount(): number {
    return this.T.length / 3;
  }

  pos(v: number): Vec3 {
    return [this.P[3 * v]!, this.P[3 * v + 1]!, this.P[3 * v + 2]!];
  }

  setPos(v: number, p: Vec3): void {
    this.P[3 * v] = p[0];
    this.P[3 * v + 1] = p[1];
    this.P[3 * v + 2] = p[2];
  }

  alive(v: number): boolean {
    return this.vt[v]!.length > 0;
  }

  triAlive(t: number): boolean {
    return this.T[3 * t] !== -1;
  }

  tri(t: number): [number, number, number] {
    return [this.T[3 * t]!, this.T[3 * t + 1]!, this.T[3 * t + 2]!];
  }

  hasVertex(t: number, v: number): boolean {
    return this.T[3 * t] === v || this.T[3 * t + 1] === v || this.T[3 * t + 2] === v;
  }

  edgeTris(a: number, b: number): number[] {
    return this.vt[a]!.filter((t) => this.hasVertex(t, b));
  }

  /** Neighbour → number of shared triangles (1 = boundary edge). */
  neighborCounts(v: number): Map<number, number> {
    const m = new Map<number, number>();
    for (const t of this.vt[v]!) {
      for (let e = 0; e < 3; e++) {
        const u = this.T[3 * t + e]!;
        if (u !== v) m.set(u, (m.get(u) ?? 0) + 1);
      }
    }
    return m;
  }

  /** A vertex is on the boundary iff its one-ring has fewer triangles than neighbours. */
  isBoundary(v: number): boolean {
    return this.vt[v]!.length < this.valence(v);
  }

  valence(v: number): number {
    // Distinct neighbours; one-rings are small (≈6), so a linear scan beats a Map.
    const seen: number[] = [];
    for (const t of this.vt[v]!) {
      for (let e = 0; e < 3; e++) {
        const u = this.T[3 * t + e]!;
        if (u !== v && !seen.includes(u)) seen.push(u);
      }
    }
    return seen.length;
  }

  addVertex(p: Vec3, curve: number): number {
    this.P.push(p[0], p[1], p[2]);
    this.vt.push([]);
    this.curve.push(curve);
    return this.vertexCount - 1;
  }

  addTri(a: number, b: number, c: number): number {
    const t = this.triangleCount;
    this.T.push(a, b, c);
    this.vt[a]!.push(t);
    this.vt[b]!.push(t);
    this.vt[c]!.push(t);
    return t;
  }

  removeTri(t: number): void {
    for (let e = 0; e < 3; e++) {
      const v = this.T[3 * t + e]!;
      const list = this.vt[v]!;
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
    }
    this.T[3 * t] = this.T[3 * t + 1] = this.T[3 * t + 2] = -1;
  }

  /** Unit normal of triangle t with optional override position for one vertex. */
  triNormal(t: number, override = -1, p: Vec3 | null = null): Vec3 {
    const [a, b, c] = this.tri(t);
    const pa = a === override && p ? p : this.pos(a);
    const pb = b === override && p ? p : this.pos(b);
    const pc = c === override && p ? p : this.pos(c);
    return cross(sub(pb, pa), sub(pc, pa));
  }

  /** Unique undirected edges of alive triangles. */
  edges(): Array<[number, number]> {
    const seen = new Set<number>();
    const out: Array<[number, number]> = [];
    for (let t = 0; t < this.triangleCount; t++) {
      if (!this.triAlive(t)) continue;
      for (let e = 0; e < 3; e++) {
        const a = this.T[3 * t + e]!, b = this.T[3 * t + ((e + 1) % 3)]!;
        const k = edgeKey(a, b);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(a < b ? [a, b] : [b, a]);
        }
      }
    }
    return out;
  }

  edgeLength(a: number, b: number): number {
    return len(sub(this.pos(a), this.pos(b)));
  }

  /** Compact into flat arrays; returns old→new vertex map as well. */
  toArrays(): { positions: Float32Array; indices: Uint32Array; curve: Int32Array } {
    const remap = new Int32Array(this.vertexCount).fill(-1);
    let n = 0;
    for (let v = 0; v < this.vertexCount; v++) if (this.alive(v)) remap[v] = n++;
    const positions = new Float32Array(3 * n);
    const curve = new Int32Array(n);
    for (let v = 0; v < this.vertexCount; v++) {
      const r = remap[v]!;
      if (r < 0) continue;
      positions[3 * r] = this.P[3 * v]!;
      positions[3 * r + 1] = this.P[3 * v + 1]!;
      positions[3 * r + 2] = this.P[3 * v + 2]!;
      curve[r] = this.curve[v]!;
    }
    const idx: number[] = [];
    for (let t = 0; t < this.triangleCount; t++) {
      if (!this.triAlive(t)) continue;
      idx.push(remap[this.T[3 * t]!]!, remap[this.T[3 * t + 1]!]!, remap[this.T[3 * t + 2]!]!);
    }
    return { positions, indices: Uint32Array.from(idx), curve };
  }
}

export interface RemeshOptions {
  targetEdge: number;
  iterations: number;
  /** Tangential relaxation step (0..1). */
  relax?: number;
}

export function isotropicRemesh(m: DynMesh, target: RemeshTarget, opts: RemeshOptions): void {
  const L = opts.targetEdge;
  const hi = (4 / 3) * L, lo = (4 / 5) * L;
  for (let it = 0; it < opts.iterations; it++) {
    splitLongEdges(m, target, hi);
    collapseShortEdges(m, target, lo, hi);
    equalizeValences(m);
    tangentialRelax(m, target, opts.relax ?? 0.8);
  }
  delaunayFlips(m, 0.985, 20);
}

export function splitLongEdges(m: DynMesh, target: RemeshTarget, hi: number): void {
  for (let round = 0; round < 8; round++) {
    let count = 0;
    for (const [a, b] of m.edges()) {
      if (m.edgeLength(a, b) <= hi) continue;
      if (splitEdge(m, target, a, b)) count++;
    }
    if (count === 0) break;
  }
}

export function splitEdge(m: DynMesh, target: RemeshTarget, a: number, b: number): boolean {
  const ts = m.edgeTris(a, b);
  if (ts.length === 0 || ts.length > 2) return false;
  const pa = m.pos(a), pb = m.pos(b);
  const mid: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
  const boundary = ts.length === 1;
  const curve = boundary ? m.curve[a]! : -1;
  const p = boundary ? target.projectCurve(mid, curve) : target.projectSurface(mid);
  const v = m.addVertex(p, curve);
  for (const t of ts) {
    const tri = m.tri(t);
    let r = 0;
    for (; r < 3; r++) {
      const u = tri[r]!, w = tri[(r + 1) % 3]!;
      if ((u === a && w === b) || (u === b && w === a)) break;
    }
    const u = tri[r]!, w = tri[(r + 1) % 3]!, c = tri[(r + 2) % 3]!;
    // Replace (u, w, c) with (u, v, c) + (v, w, c).
    m.T[3 * t] = u;
    m.T[3 * t + 1] = v;
    m.T[3 * t + 2] = c;
    const lw = m.vt[w]!;
    lw.splice(lw.indexOf(t), 1);
    m.vt[v]!.push(t);
    m.addTri(v, w, c);
  }
  return true;
}

export function collapseShortEdges(m: DynMesh, target: RemeshTarget, lo: number, hi: number): void {
  const cand = m
    .edges()
    .map(([a, b]) => ({ a, b, l: m.edgeLength(a, b) }))
    .filter((e) => e.l < lo)
    .sort((x, y) => x.l - y.l);
  for (const { a, b } of cand) {
    if (!m.alive(a) || !m.alive(b)) continue;
    if (m.edgeLength(a, b) >= lo) continue;
    collapseEdge(m, target, a, b, hi);
  }
}

/** Collapse edge (a,b); returns true on success. Keeps topology manifold and avoids fold-overs. */
export function collapseEdge(m: DynMesh, target: RemeshTarget, a: number, b: number, hi: number): boolean {
  const ts = m.edgeTris(a, b);
  if (ts.length === 0) return false;
  const ba = m.isBoundary(a), bb = m.isBoundary(b);
  const boundaryEdge = ts.length === 1;
  let pnew: Vec3;
  if (boundaryEdge) {
    if (m.curve[a] !== m.curve[b]) return false;
    const pa = m.pos(a), pb = m.pos(b);
    pnew = target.projectCurve([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2], m.curve[a]!);
  } else if (ba && bb) {
    return false;
  } else if (bb) {
    [a, b] = [b, a];
    pnew = m.pos(a);
  } else if (ba) {
    pnew = m.pos(a);
  } else {
    const pa = m.pos(a), pb = m.pos(b);
    pnew = target.projectSurface([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
  }

  // Link condition: common neighbours must be exactly the opposite vertices.
  const na = m.neighborCounts(a), nb = m.neighborCounts(b);
  const opposite = ts.map((t) => m.tri(t).find((x) => x !== a && x !== b)!);
  let common = 0;
  for (const u of na.keys()) if (nb.has(u)) common++;
  if (common !== opposite.length) return false;
  for (const o of opposite) {
    if (m.valence(o) <= 3) return false;
  }
  // Boundary loops must keep at least 3 vertices; refuse when the loop is tiny.
  if (boundaryEdge && na.size + nb.size < 6) return false;

  for (const u of new Set([...na.keys(), ...nb.keys()])) {
    if (u === a || u === b) continue;
    if (len(sub(pnew, m.pos(u))) > hi) return false;
  }
  // Orientation check on surviving triangles.
  const affected = new Set([...m.vt[a]!, ...m.vt[b]!]);
  for (const t of ts) affected.delete(t);
  for (const t of affected) {
    const before = normalize(m.triNormal(t));
    const mover = m.hasVertex(t, a) ? a : b;
    const afterRaw = m.triNormal(t, mover, pnew);
    const al = len(afterRaw);
    if (al < 1e-8) return false;
    if (dot(before, [afterRaw[0] / al, afterRaw[1] / al, afterRaw[2] / al]) < 0.4) return false;
  }

  for (const t of ts) m.removeTri(t);
  for (const t of [...m.vt[b]!]) {
    for (let e = 0; e < 3; e++) if (m.T[3 * t + e] === b) m.T[3 * t + e] = a;
    m.vt[a]!.push(t);
  }
  m.vt[b] = [];
  m.setPos(a, pnew);
  return true;
}

/** Orient so that t1 = (a, b, c) and t2 = (b, a, d); returns null for boundary/non-manifold edges. */
function flipConfig(m: DynMesh, a: number, b: number): { t1: number; t2: number; a: number; b: number; c: number; d: number } | null {
  const ts = m.edgeTris(a, b);
  if (ts.length !== 2) return null;
  let [t1, t2] = ts as [number, number];
  const hasDirected = (t: number, x: number, y: number) => {
    const tri = m.tri(t);
    for (let r = 0; r < 3; r++) if (tri[r] === x && tri[(r + 1) % 3] === y) return true;
    return false;
  };
  if (!hasDirected(t1, a, b)) [t1, t2] = [t2, t1];
  if (!hasDirected(t1, a, b) || !hasDirected(t2, b, a)) return null;
  const c = m.tri(t1).find((x) => x !== a && x !== b)!;
  const d = m.tri(t2).find((x) => x !== a && x !== b)!;
  if (c === d) return null;
  return { t1, t2, a, b, c, d };
}

/** Flip edge (a,b) → (c,d) if geometrically safe. */
export function flipEdge(m: DynMesh, a: number, b: number, flatTol: number): boolean {
  const cfg = flipConfig(m, a, b);
  if (!cfg) return false;
  const { t1, t2, c, d } = cfg;
  if (m.neighborCounts(c).has(d)) return false;
  if (m.valence(cfg.a) <= 3 || m.valence(cfg.b) <= 3) return false;
  const pa = m.pos(cfg.a), pb = m.pos(cfg.b), pc = m.pos(c), pd = m.pos(d);
  const n1 = normalize(cross(sub(pb, pa), sub(pc, pa)));
  const n2 = normalize(cross(sub(pa, pb), sub(pd, pb)));
  if (dot(n1, n2) < flatTol) return false;
  const avg = normalize([n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]]);
  const nA = cross(sub(pd, pa), sub(pc, pa));
  const nB = cross(sub(pc, pb), sub(pd, pb));
  if (len(nA) < 1e-8 || len(nB) < 1e-8) return false;
  if (dot(normalize(nA), avg) < 0.5 || dot(normalize(nB), avg) < 0.5) return false;
  m.T[3 * t1] = cfg.a; m.T[3 * t1 + 1] = d; m.T[3 * t1 + 2] = c;
  m.T[3 * t2] = cfg.b; m.T[3 * t2 + 1] = c; m.T[3 * t2 + 2] = d;
  const lb = m.vt[cfg.b]!;
  lb.splice(lb.indexOf(t1), 1);
  m.vt[d]!.push(t1);
  const la = m.vt[cfg.a]!;
  la.splice(la.indexOf(t2), 1);
  m.vt[c]!.push(t2);
  return true;
}

export function equalizeValences(m: DynMesh): void {
  // Valence and boundary flags are cached for the pass; interior flips change valences of
  // exactly four vertices and never change boundary status.
  const n = m.vertexCount;
  const val = new Int32Array(n);
  const tgt = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    if (!m.alive(v)) continue;
    const nc = m.neighborCounts(v);
    val[v] = nc.size;
    let bnd = false;
    for (const c of nc.values()) if (c === 1) bnd = true;
    tgt[v] = bnd ? 4 : 6;
  }
  for (const [a, b] of m.edges()) {
    const cfg = flipConfig(m, a, b);
    if (!cfg) continue;
    const { c, d } = cfg;
    const dev = (v: number, delta: number) => Math.abs(val[v]! + delta - tgt[v]!);
    const before = dev(a, 0) + dev(b, 0) + dev(c, 0) + dev(d, 0);
    const after = dev(a, -1) + dev(b, -1) + dev(c, 1) + dev(d, 1);
    if (after < before && flipEdge(m, a, b, 0.6)) {
      val[a]--; val[b]--; val[c]++; val[d]++;
    }
  }
}

export function tangentialRelax(m: DynMesh, target: RemeshTarget, lambda: number): void {
  const n = m.vertexCount;
  const next: Array<Vec3 | null> = new Array(n).fill(null);
  for (let v = 0; v < n; v++) {
    if (!m.alive(v)) continue;
    const nc = m.neighborCounts(v);
    const p = m.pos(v);
    const bnd = [...nc.entries()].filter(([, c]) => c === 1).map(([u]) => u);
    if (bnd.length > 0) {
      if (bnd.length !== 2) continue;
      const q0 = m.pos(bnd[0]!), q1 = m.pos(bnd[1]!);
      const q: Vec3 = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2];
      next[v] = target.projectCurve([p[0] + lambda * (q[0] - p[0]), p[1] + lambda * (q[1] - p[1]), p[2] + lambda * (q[2] - p[2])], m.curve[v]!);
      continue;
    }
    // Area-weighted centroid of the one-ring (triangle centroids weighted by area).
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (const t of m.vt[v]!) {
      const [a, b, c] = m.tri(t);
      const pa = m.pos(a), pb = m.pos(b), pc = m.pos(c);
      const w = len(cross(sub(pb, pa), sub(pc, pa)));
      sx += (w * (pa[0] + pb[0] + pc[0])) / 3;
      sy += (w * (pa[1] + pb[1] + pc[1])) / 3;
      sz += (w * (pa[2] + pb[2] + pc[2])) / 3;
      sw += w;
    }
    if (sw <= 0) continue;
    const d: Vec3 = [sx / sw - p[0], sy / sw - p[1], sz / sw - p[2]];
    const nrm = target.normal(p);
    const dn = dot(d, nrm);
    next[v] = target.projectSurface([
      p[0] + lambda * (d[0] - dn * nrm[0]),
      p[1] + lambda * (d[1] - dn * nrm[1]),
      p[2] + lambda * (d[2] - dn * nrm[2]),
    ]);
  }
  for (let v = 0; v < n; v++) {
    const q = next[v];
    if (q) m.setPos(v, q);
  }
}

/** Flip edges whose opposite angles sum to more than π (extrinsic Delaunay), on near-flat pairs only. */
export function delaunayFlips(m: DynMesh, flatTol: number, maxPasses: number): number {
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    let flips = 0;
    for (const [a0, b0] of m.edges()) {
      const cfg = flipConfig(m, a0, b0);
      if (!cfg) continue;
      const { a, b, c, d } = cfg;
      const pa = m.pos(a), pb = m.pos(b), pc = m.pos(c), pd = m.pos(d);
      const angle = (o: Vec3, x: Vec3, y: Vec3) => {
        const u = sub(x, o), w = sub(y, o);
        return Math.atan2(len(cross(u, w)), dot(u, w));
      };
      if (angle(pc, pa, pb) + angle(pd, pa, pb) > Math.PI + 1e-6) {
        if (flipEdge(m, a, b, flatTol)) flips++;
      }
    }
    total += flips;
    if (flips === 0) break;
  }
  return total;
}
