import type { Adjacency } from './topology';

/** Binary min-heap keyed by float priority (used by Dijkstra / fast marching). */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }

  /** Pops the minimum; returns [key, val]. Caller must check size > 0. */
  pop(): [number, number] {
    const k = this.keys, v = this.vals;
    const topK = k[0]!, topV = v[0]!;
    const lastK = k.pop()!, lastV = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lastK;
        if (l < n && k[l]! < mk) { m = l; mk = k[l]!; }
        if (r < n && k[r]! < mk) { m = r; mk = k[r]!; }
        if (m === i) break;
        k[i] = k[m]!;
        v[i] = v[m]!;
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

export interface DijkstraResult {
  distance: Float64Array;
  /** Index (into `sources`) of the nearest source; -1 if unreached. */
  nearestSource: Int32Array;
}

/**
 * Multi-source Dijkstra along mesh edges (Euclidean edge weights). Overestimates true
 * geodesic distance by a few percent on well-shaped meshes; adequate for labelling and
 * region growing. `maxDistance` truncates the search.
 */
export function edgeDijkstra(
  positions: ArrayLike<number>,
  adj: Adjacency,
  sources: ArrayLike<number>,
  maxDistance = Infinity,
): DijkstraResult {
  const nV = positions.length / 3;
  const distance = new Float64Array(nV).fill(Infinity);
  const nearestSource = new Int32Array(nV).fill(-1);
  const heap = new MinHeap();
  for (let s = 0; s < sources.length; s++) {
    const v = sources[s]!;
    distance[v] = 0;
    nearestSource[v] = s;
    heap.push(0, v);
  }
  while (heap.size > 0) {
    const [d, v] = heap.pop();
    if (d > distance[v]!) continue;
    for (let j = adj.offsets[v]!; j < adj.offsets[v + 1]!; j++) {
      const u = adj.neighbors[j]!;
      const w = Math.hypot(
        positions[3 * u]! - positions[3 * v]!,
        positions[3 * u + 1]! - positions[3 * v + 1]!,
        positions[3 * u + 2]! - positions[3 * v + 2]!,
      );
      const nd = d + w;
      if (nd < distance[u]! && nd <= maxDistance) {
        distance[u] = nd;
        nearestSource[u] = nearestSource[v]!;
        heap.push(nd, u);
      }
    }
  }
  return { distance, nearestSource };
}
