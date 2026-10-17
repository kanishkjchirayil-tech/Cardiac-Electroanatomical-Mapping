import { boundaryLoops, edgeStats, type EdgeStats } from './topology';

export interface MeshQuality extends EdgeStats {
  vertices: number;
  triangles: number;
  eulerCharacteristic: number;
  boundaryLoopCount: number;
  meanEdge: number;
  minEdge: number;
  maxEdge: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  /** Fraction of triangles with an angle > 90°. */
  obtuseFraction: number;
  area: number;
}

/** Geometric and topological quality summary used by tests and the UI status bar. */
export function meshQuality(positions: ArrayLike<number>, indices: ArrayLike<number>): MeshQuality {
  const es = edgeStats(indices);
  const nV = positions.length / 3;
  const nF = indices.length / 3;
  const edges = es.boundaryEdges + es.interiorEdges + es.nonManifoldEdges;
  let sumEdge = 0, nEdge = 0, minEdge = Infinity, maxEdge = 0;
  let minA = 180, maxA = 0, obtuse = 0, area = 0;
  const seen = new Set<number>();
  const P = (i: number, c: number) => positions[3 * i + c]!;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const L: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e]!, b = v[(e + 1) % 3]!;
      const l = Math.hypot(P(a, 0) - P(b, 0), P(a, 1) - P(b, 1), P(a, 2) - P(b, 2));
      L.push(l);
      const k = a < b ? a * 0x200000 + b : b * 0x200000 + a;
      if (!seen.has(k)) {
        seen.add(k);
        sumEdge += l;
        nEdge++;
        minEdge = Math.min(minEdge, l);
        maxEdge = Math.max(maxEdge, l);
      }
    }
    // Angles via the law of cosines; angle e is opposite edge (e+1)%3.
    let isObtuse = false;
    for (let e = 0; e < 3; e++) {
      const a = L[e]!, b = L[(e + 2) % 3]!, c = L[(e + 1) % 3]!;
      const cosv = Math.min(1, Math.max(-1, (a * a + b * b - c * c) / (2 * a * b)));
      const ang = (Math.acos(cosv) * 180) / Math.PI;
      minA = Math.min(minA, ang);
      maxA = Math.max(maxA, ang);
      if (ang > 90) isObtuse = true;
    }
    if (isObtuse) obtuse++;
    const s = (L[0]! + L[1]! + L[2]!) / 2;
    area += Math.sqrt(Math.max(0, s * (s - L[0]!) * (s - L[1]!) * (s - L[2]!)));
  }
  return {
    ...es,
    vertices: nV,
    triangles: nF,
    eulerCharacteristic: nV - edges + nF,
    boundaryLoopCount: boundaryLoops(indices).length,
    meanEdge: sumEdge / Math.max(1, nEdge),
    minEdge,
    maxEdge,
    minAngleDeg: minA,
    maxAngleDeg: maxA,
    obtuseFraction: obtuse / Math.max(1, nF),
    area,
  };
}
