import type { SurfaceMesh } from '../mesh/types';
import type { PvName } from '../mesh/regions';
import { PV_REGIONS } from '../mesh/regions';
import { vertexAdjacency } from '../mesh/topology';
import { edgeDijkstra } from '../mesh/geodesic';
import { cross, getV, normalize, perpendicular, sub, dot, dist } from '../math/vec3';

/**
 * Lesion-centre vertices on a closed contour around a pulmonary vein ostium, at geodesic distance
 * `offset` (mm) on the atrial side, spaced ≈ `spacing` mm apart. Uses anatomical landmarks, so it
 * is for scenario setup and tests (an "ideal operator"), never for map construction.
 */
export function antralRing(mesh: SurfaceMesh, pv: PvName, offset = 5, spacing = 4): number[] {
  const lm = mesh.anatomy?.pvs.find((p) => p.name === pv);
  if (!lm) throw new Error(`No landmark for ${pv}`);
  const nV = mesh.region.length;
  const adj = vertexAdjacency(mesh.indices, nV);
  const { distance } = edgeDijkstra(mesh.positions, adj, lm.ostiumRing, offset + 4);
  const sleeves = new Set<number>(PV_REGIONS);
  // Angular bins around the vein axis; each keeps the vertex whose distance is closest to `offset`.
  const u = perpendicular(lm.axis), w = normalize(cross(lm.axis, u));
  const BINS = 144;
  const best = new Int32Array(BINS).fill(-1), err = new Float64Array(BINS).fill(Infinity);
  for (let i = 0; i < nV; i++) {
    const d = distance[i]!;
    if (!Number.isFinite(d) || sleeves.has(mesh.region[i]!) || Math.abs(d - offset) > 1.2) continue;
    const r = sub(getV(mesh.positions, i), lm.ostiumCenter);
    const th = Math.atan2(dot(r, w), dot(r, u));
    const b = Math.min(BINS - 1, Math.floor(((th + Math.PI) / (2 * Math.PI)) * BINS));
    if (Math.abs(d - offset) < err[b]!) { err[b] = Math.abs(d - offset); best[b] = i; }
  }
  const contour = Array.from(best).filter((v) => v >= 0);
  if (contour.length < 8) throw new Error(`Could not trace a ring around ${pv}`);
  // Walk the closed contour and place a centre every `spacing` mm of arc.
  let perim = 0;
  for (let k = 0; k < contour.length; k++) perim += dist(getV(mesh.positions, contour[k]!), getV(mesh.positions, contour[(k + 1) % contour.length]!));
  const n = Math.max(3, Math.round(perim / spacing));
  const step = perim / n;
  const out: number[] = [contour[0]!];
  let acc = 0;
  for (let k = 1; k < contour.length && out.length < n; k++) {
    acc += dist(getV(mesh.positions, contour[k - 1]!), getV(mesh.positions, contour[k]!));
    if (acc >= step * out.length) out.push(contour[k]!);
  }
  return out;
}
