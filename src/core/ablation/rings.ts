import type { SurfaceMesh } from '../mesh/types';
import type { PvName } from '../mesh/regions';
import { PV_NAMES, PV_REGIONS } from '../mesh/regions';
import { vertexAdjacency } from '../mesh/topology';
import { edgeDijkstra } from '../mesh/geodesic';
import { cross, dist, dot, getV, normalize, perpendicular, sub } from '../math/vec3';

/**
 * Lesion-centre vertices on a closed contour around one or more pulmonary vein ostia (a pair gives
 * a wide antral circumferential ring around both ipsilateral veins). The contour is the outer
 * boundary of the region within geodesic distance `offset` (mm) of the ostia, seen from the LA
 * body; it is Poisson-disc sampled at ≈ `spacing` mm and ordered into a chain. Uses anatomical
 * landmarks, so it is for scenario setup and tests (an "ideal operator"), never for map
 * construction.
 */
export function antralRing(mesh: SurfaceMesh, pvs: PvName | PvName[], offset = 5, spacing = 4): number[] {
  const names = Array.isArray(pvs) ? pvs : [pvs];
  const lms = names.map((pv) => {
    const lm = mesh.anatomy?.pvs.find((p) => p.name === pv);
    if (!lm) throw new Error(`No landmark for ${pv}`);
    return lm;
  });
  const P = mesh.positions;
  const nV = mesh.region.length;
  const adj = vertexAdjacency(mesh.indices, nV);
  const seeds = lms.flatMap((l) => Array.from(l.ostiumRing));
  if (lms.length === 2) {
    // Bridge the carina: the shortest edge path between the two ostia joins the veins into one
    // region, so the ring passes outside the carina (a wide antral circumferential ring).
    const dA = edgeDijkstra(P, adj, lms[0]!.ostiumRing).distance;
    let cur = Array.from(lms[1]!.ostiumRing).reduce((b, v) => (dA[v]! < dA[b]! ? v : b));
    while (dA[cur]! > 0) {
      seeds.push(cur);
      let nx = cur;
      for (let k = adj.offsets[cur]!; k < adj.offsets[cur + 1]!; k++) if (dA[adj.neighbors[k]!]! < dA[nx]!) nx = adj.neighbors[k]!;
      if (nx === cur) break;
      cur = nx;
    }
  }
  const { distance } = edgeDijkstra(P, adj, seeds, offset + 2);
  const sleeve = new Set<number>(names.map((n) => PV_REGIONS[PV_NAMES.indexOf(n)]!));
  const inside = new Uint8Array(nV);
  for (let i = 0; i < nV; i++) if (distance[i]! <= offset || sleeve.has(mesh.region[i]!)) inside[i] = 1;
  // The LA body: everything outside, reached from the vertex farthest from the veins.
  const centre = [0, 1, 2].map((k) => lms.reduce((a, l) => a + l.ostiumCenter[k]!, 0) / lms.length) as [number, number, number];
  let far = 0, fd = -1;
  for (let i = 0; i < nV; i++) { const d = dist(getV(P, i), centre); if (d > fd) { fd = d; far = i; } }
  const body = new Uint8Array(nV);
  const stack = [far];
  body[far] = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (let k = adj.offsets[v]!; k < adj.offsets[v + 1]!; k++) {
      const w = adj.neighbors[k]!;
      if (!inside[w] && !body[w]) { body[w] = 1; stack.push(w); }
    }
  }
  const contour: number[] = [];
  for (let i = 0; i < nV; i++) {
    if (!inside[i]) continue;
    for (let k = adj.offsets[i]!; k < adj.offsets[i + 1]!; k++) if (body[adj.neighbors[k]!]) { contour.push(i); break; }
  }
  if (contour.length < 8) throw new Error(`Could not trace a ring around ${names.join('+')}`);
  // Poisson-disc subsample (every contour vertex lies within 0.6·spacing of a centre).
  const r = 0.6 * spacing;
  const picked: number[] = [];
  for (const v of contour) if (!picked.some((q) => dist(getV(P, q), getV(P, v)) < r)) picked.push(v);
  // Order around the ring: by angle about the ring centroid, in the plane normal to the mean vein axis.
  const axis = normalize([0, 1, 2].map((k) => lms.reduce((acc, l) => acc + l.axis[k]!, 0)) as [number, number, number]);
  const c = [0, 1, 2].map((k) => picked.reduce((acc, v) => acc + P[3 * v + k]!, 0) / picked.length) as [number, number, number];
  const u = perpendicular(axis), w = cross(axis, u);
  const ang = (v: number) => { const q = sub(getV(P, v), c); return Math.atan2(dot(q, w), dot(q, u)); };
  const out = [...picked].sort((x, y) => ang(x) - ang(y));
  return out;
}
