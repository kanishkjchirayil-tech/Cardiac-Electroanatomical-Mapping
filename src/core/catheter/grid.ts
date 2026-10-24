import { add, cross, getV, normalize, perpendicular, scale, type Vec3 } from '../math/vec3';
import type { SpatialGrid } from '../mesh/spatial';
import { contactGap } from './roving';

/**
 * High-density grid catheter (MODEL.md §4.1): 4 × 4 electrodes (1 mm), 3 mm centre-to-centre,
 * lying flat on the wall. Each electrode is snapped to the nearest surface point of its in-plane
 * grid position and held off the endocardium by the contact gap plus its radius.
 */
export const GRID_N = 4;
export const GRID_SPACING = 3;
export const GRID_COUNT = GRID_N * GRID_N;
const ELECTRODE_LIFT = 0.6;

export interface GridPose {
  contact: Vec3;
  normal: Vec3;
  /** In-plane row (u) and column (v) directions. */
  u: Vec3;
  v: Vec3;
  /** Electrode centres, row-major (index = row·4 + col). */
  electrodes: Vec3[];
  force: number;
  gap: number;
}

export function gridPose(
  positions: Float32Array,
  normals: Float32Array,
  index: SpatialGrid,
  contact: Vec3,
  normal: Vec3,
  azimuthDeg: number,
  force: number,
  displacement: Vec3 = [0, 0, 0],
): GridPose {
  const t1 = perpendicular(normal), t2 = cross(normal, t1);
  const a = (azimuthDeg * Math.PI) / 180;
  const u = normalize(add(scale(t1, Math.cos(a)), scale(t2, Math.sin(a))));
  const v = cross(normal, u);
  const gap = contactGap(force);
  const electrodes: Vec3[] = [];
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const g = add(add(contact, scale(u, (c - 1.5) * GRID_SPACING)), scale(v, (r - 1.5) * GRID_SPACING));
      const k = index.nearest(g).index;
      const p = getV(positions, k), n = getV(normals, k);
      electrodes.push(add(add(p, scale(n, -(gap + ELECTRODE_LIFT))), displacement));
    }
  }
  return { contact, normal, u, v, electrodes, force, gap };
}

/** Bipole partner along the row: the next electrode, or the previous one for the last column. */
export function gridPartner(k: number): number {
  return k % GRID_N === GRID_N - 1 ? k - 1 : k + 1;
}
