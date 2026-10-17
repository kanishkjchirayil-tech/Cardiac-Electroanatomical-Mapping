/** Connectivity utilities on indexed triangle meshes (no geometry assumptions). */

export interface Adjacency {
  /** CSR row offsets, length nV + 1. */
  offsets: Uint32Array;
  /** Neighbour vertex ids, sorted per row. */
  neighbors: Uint32Array;
}

/** Undirected vertex–vertex adjacency (CSR). */
export function vertexAdjacency(indices: ArrayLike<number>, nV: number): Adjacency {
  const sets: number[][] = Array.from({ length: nV }, () => []);
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!;
      sets[a]!.push(b);
      sets[b]!.push(a);
    }
  }
  const offsets = new Uint32Array(nV + 1);
  const rows: number[][] = new Array(nV);
  for (let v = 0; v < nV; v++) {
    const row = Array.from(new Set(sets[v]!)).sort((x, y) => x - y);
    rows[v] = row;
    offsets[v + 1] = offsets[v]! + row.length;
  }
  const neighbors = new Uint32Array(offsets[nV]!);
  for (let v = 0; v < nV; v++) neighbors.set(rows[v]!, offsets[v]!);
  return { offsets, neighbors };
}

/** Map from undirected edge key to the number of incident triangles. */
export function edgeKey(a: number, b: number): number {
  return a < b ? a * 0x200000 + b : b * 0x200000 + a;
}

export interface EdgeStats {
  /** Undirected edges with exactly one incident triangle. */
  boundaryEdges: number;
  interiorEdges: number;
  /** Edges with more than two incident triangles. */
  nonManifoldEdges: number;
  /** Directed half-edges that appear more than once (inconsistent orientation). */
  duplicateHalfEdges: number;
}

export function edgeStats(indices: ArrayLike<number>): EdgeStats {
  const count = new Map<number, number>();
  const directed = new Set<number>();
  let duplicateHalfEdges = 0;
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!;
      const k = edgeKey(a, b);
      count.set(k, (count.get(k) ?? 0) + 1);
      const dk = a * 0x200000 + b;
      if (directed.has(dk)) duplicateHalfEdges++;
      directed.add(dk);
    }
  }
  let boundaryEdges = 0, interiorEdges = 0, nonManifoldEdges = 0;
  for (const c of count.values()) {
    if (c === 1) boundaryEdges++;
    else if (c === 2) interiorEdges++;
    else nonManifoldEdges++;
  }
  return { boundaryEdges, interiorEdges, nonManifoldEdges, duplicateHalfEdges };
}

/**
 * Ordered boundary loops, following the orientation of the triangles
 * (boundary half-edges a→b whose twin b→a does not exist).
 */
export function boundaryLoops(indices: ArrayLike<number>): number[][] {
  const directed = new Set<number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) directed.add(indices[t + e]! * 0x200000 + indices[t + ((e + 1) % 3)]!);
  }
  const next = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!;
      if (!directed.has(b * 0x200000 + a)) next.set(a, b);
    }
  }
  const loops: number[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!visited.has(v)) {
      visited.add(v);
      loop.push(v);
      const n = next.get(v);
      if (n === undefined) break;
      v = n;
    }
    loops.push(loop);
  }
  return loops;
}

/** Area-weighted vertex normals. */
export function computeVertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = new Float64Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t]!, b = 3 * indices[t + 1]!, c = 3 * indices[t + 2]!;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] = n[i]! + nx;
      n[i + 1] = n[i + 1]! + ny;
      n[i + 2] = n[i + 2]! + nz;
    }
  }
  const out = new Float32Array(positions.length);
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    out[i] = n[i]! / l;
    out[i + 1] = n[i + 1]! / l;
    out[i + 2] = n[i + 2]! / l;
  }
  return out;
}

/** Remove unreferenced vertices; returns the compacted arrays and old→new map (-1 for removed). */
export function compactVertices(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): { positions: Float32Array; indices: Uint32Array; remap: Int32Array } {
  const nV = positions.length / 3;
  const remap = new Int32Array(nV).fill(-1);
  // Preserve original vertex order for determinism / readability.
  let k = 0;
  const used = new Uint8Array(nV);
  for (let i = 0; i < indices.length; i++) used[indices[i]!] = 1;
  for (let v = 0; v < nV; v++) remap[v] = used[v] ? k++ : -1;
  const pos = new Float32Array(3 * k);
  for (let v = 0; v < nV; v++) {
    const r = remap[v]!;
    if (r >= 0) {
      pos[3 * r] = positions[3 * v]!;
      pos[3 * r + 1] = positions[3 * v + 1]!;
      pos[3 * r + 2] = positions[3 * v + 2]!;
    }
  }
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) idx[i] = remap[indices[i]!]!;
  return { positions: pos, indices: idx, remap };
}
