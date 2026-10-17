import type { Vec3 } from '../math/vec3';
import type { PvName } from './regions';

/**
 * Triangulated endocardial surface. Coordinates are millimetres in a patient
 * frame: +x = patient Left, +y = Posterior, +z = Superior (LPS).
 */
export interface SurfaceMesh {
  positions: Float32Array; // 3 * nV
  indices: Uint32Array; // 3 * nF, counter-clockwise seen from outside (normals point out of the blood pool)
  normals: Float32Array; // 3 * nV, area-weighted vertex normals
  region: Uint8Array; // nV, values of Region
  wallThickness: Float32Array; // nV, mm
  /** Ordered vertex loops of open boundaries (PV ends, mitral annulus). */
  boundaryLoops: BoundaryLoop[];
  /** Landmarks for procedurally generated anatomy; absent for imported meshes unless provided. */
  anatomy?: AnatomyLandmarks;
}

export interface BoundaryLoop {
  /** e.g. 'LSPV', 'MV', or 'loop3' for unlabeled imported openings. */
  label: string;
  vertices: Uint32Array;
}

export interface PvLandmark {
  name: PvName;
  /** Point on the vein axis at the ostium (end of the antral funnel). */
  ostiumCenter: Vec3;
  /** Unit vector along the vein, pointing away from the atrium. */
  axis: Vec3;
  ostiumRadius: number;
  /** Vertices of the vein sleeve that border the antrum. */
  ostiumRing: Uint32Array;
}

export interface AnatomyLandmarks {
  bodyCenter: Vec3;
  bodyRadii: Vec3;
  pvs: PvLandmark[];
  mitral: { center: Vec3; normal: Vec3; radius: number };
  laa: { base: Vec3; axis: Vec3 };
}

export function vertexCount(m: { positions: ArrayLike<number> }): number {
  return m.positions.length / 3;
}

export function triangleCount(m: { indices: ArrayLike<number> }): number {
  return m.indices.length / 3;
}
