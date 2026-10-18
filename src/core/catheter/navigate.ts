import type { Adjacency } from '../mesh/topology';

/**
 * Move along the surface from `start` by roughly `distance` mm in direction `dir` (projected onto
 * the local tangent plane at each step), hopping between neighbouring vertices. Used for keyboard
 * nudges of the roving catheter.
 */
export function walkOnSurface(
  positions: Float32Array,
  normals: Float32Array,
  adj: Adjacency,
  start: number,
  dir: [number, number, number],
  distance: number,
): number {
  let cur = start, travelled = 0;
  for (let guard = 0; guard < 200 && travelled < distance; guard++) {
    const nx = normals[3 * cur]!, ny = normals[3 * cur + 1]!, nz = normals[3 * cur + 2]!;
    const dn = dir[0] * nx + dir[1] * ny + dir[2] * nz;
    let tx = dir[0] - dn * nx, ty = dir[1] - dn * ny, tz = dir[2] - dn * nz;
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-6) break;
    tx /= tl; ty /= tl; tz /= tl;
    let best = -1, bestDot = 0.3, bestLen = 0;
    for (let k = adj.offsets[cur]!; k < adj.offsets[cur + 1]!; k++) {
      const u = adj.neighbors[k]!;
      const ex = positions[3 * u]! - positions[3 * cur]!, ey = positions[3 * u + 1]! - positions[3 * cur + 1]!, ez = positions[3 * u + 2]! - positions[3 * cur + 2]!;
      const el = Math.hypot(ex, ey, ez);
      const d = (ex * tx + ey * ty + ez * tz) / el;
      if (d > bestDot) { bestDot = d; best = u; bestLen = el; }
    }
    if (best < 0) break;
    cur = best;
    travelled += bestLen;
  }
  return cur;
}
