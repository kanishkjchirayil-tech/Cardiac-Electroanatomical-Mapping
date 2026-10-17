import { computeVertexNormals, boundaryLoops, compactVertices, vertexAdjacency } from '../topology';
import { PV_NAMES, PV_REGIONS, REGIONS, Region, regionByKey } from '../regions';
import type { BoundaryLoop, SurfaceMesh } from '../types';
import { meshQuality } from '../quality';
import { parseObj } from './obj';
import { parsePly } from './ply';
import { parseVtk } from './vtk';
import type { RawMesh } from './raw';

/**
 * Sidecar JSON accompanying an imported mesh (see README "Importing a mesh").
 * `region` is per vertex (file order): numeric Region ids or region keys/names (e.g. "lspv", "Roof").
 * Boundary loops are named from the majority region of their vertices (PV sleeve → vein, annulus → MV).
 */
export interface LabelSidecar {
  format?: 'ostium-labels/1';
  units?: 'mm' | 'cm' | 'm';
  /** Optional 4×4 row-major affine transform into the LPS millimetre frame (applied after unit scaling). */
  transform?: number[];
  region?: Array<number | string>;
  wallThickness?: number[];
}

export interface ImportResult {
  mesh: SurfaceMesh;
  warnings: string[];
}

export type MeshFormat = 'obj' | 'ply' | 'vtk';

export function formatFromName(name: string): MeshFormat | null {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'obj' || ext === 'ply' || ext === 'vtk' ? ext : null;
}

export function parseMeshFile(format: MeshFormat, data: ArrayBuffer | Uint8Array): RawMesh {
  switch (format) {
    case 'obj': return parseObj(data);
    case 'ply': return parsePly(data);
    case 'vtk': return parseVtk(data);
  }
}

/** Merge vertices closer than `eps` (OBJ exports often duplicate seam vertices). */
export function weldVertices(raw: RawMesh, eps = 1e-5): RawMesh {
  const nV = raw.positions.length / 3;
  const map = new Map<string, number>();
  const remap = new Uint32Array(nV);
  const keep: number[] = [];
  const q = (x: number) => Math.round(x / eps);
  for (let v = 0; v < nV; v++) {
    const key = `${q(raw.positions[3 * v]!)},${q(raw.positions[3 * v + 1]!)},${q(raw.positions[3 * v + 2]!)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = keep.length;
      map.set(key, id);
      keep.push(v);
    }
    remap[v] = id;
  }
  if (keep.length === nV) return raw;
  const positions = new Float32Array(3 * keep.length);
  keep.forEach((v, i) => positions.set(raw.positions.subarray(3 * v, 3 * v + 3), 3 * i));
  const idx: number[] = [];
  for (let t = 0; t < raw.indices.length; t += 3) {
    const a = remap[raw.indices[t]!]!, b = remap[raw.indices[t + 1]!]!, c = remap[raw.indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  const pointData: Record<string, Float32Array> = {};
  for (const [k, arr] of Object.entries(raw.pointData)) pointData[k] = Float32Array.from(keep, (v) => arr[v]!);
  return { positions, indices: Uint32Array.from(idx), pointData };
}

/**
 * Turn a parsed mesh (+ optional sidecar) into a SurfaceMesh: units/transform, welding,
 * normals, labels, wall thickness and labelled boundary loops.
 */
export function importMesh(raw0: RawMesh, sidecar: LabelSidecar | null = null): ImportResult {
  const warnings: string[] = [];
  const nV0 = raw0.positions.length / 3;
  // Sidecar arrays refer to file vertex order, so attach them as point data before welding.
  const raw1: RawMesh = { ...raw0, pointData: { ...raw0.pointData } };
  if (sidecar?.region) {
    if (sidecar.region.length !== nV0) throw new Error(`Sidecar region length ${sidecar.region.length} ≠ vertex count ${nV0}`);
    raw1.pointData.region = Float32Array.from(sidecar.region, (r) => {
      if (typeof r === 'number') return r;
      const id = regionByKey(r);
      if (id === undefined) warnings.push(`Unknown region "${r}" → Unlabeled`);
      return id ?? Region.Unlabeled;
    });
  }
  if (sidecar?.wallThickness) {
    if (sidecar.wallThickness.length !== nV0) throw new Error('Sidecar wallThickness length ≠ vertex count');
    raw1.pointData.wallThickness = Float32Array.from(sidecar.wallThickness);
  }

  const raw = weldVertices(raw1);
  if (raw.positions.length !== raw1.positions.length) warnings.push(`Welded ${nV0 - raw.positions.length / 3} duplicate vertices`);
  const compact = compactVertices(raw.positions, raw.indices);
  const positions = compact.positions;
  const indices = compact.indices;
  const nV = positions.length / 3;
  const pick = (name: string): Float32Array | undefined => {
    const a = raw.pointData[name];
    if (!a) return undefined;
    const out = new Float32Array(nV);
    compact.remap.forEach((r, v) => { if (r >= 0) out[r] = a[v]!; });
    return out;
  };

  const scaleU = sidecar?.units === 'cm' ? 10 : sidecar?.units === 'm' ? 1000 : 1;
  const M = sidecar?.transform;
  if (M && M.length !== 16) throw new Error('Sidecar transform must have 16 entries');
  for (let v = 0; v < nV; v++) {
    let x = positions[3 * v]! * scaleU, y = positions[3 * v + 1]! * scaleU, z = positions[3 * v + 2]! * scaleU;
    if (M) {
      [x, y, z] = [M[0]! * x + M[1]! * y + M[2]! * z + M[3]!, M[4]! * x + M[5]! * y + M[6]! * z + M[7]!, M[8]! * x + M[9]! * y + M[10]! * z + M[11]!];
    }
    positions[3 * v] = x;
    positions[3 * v + 1] = y;
    positions[3 * v + 2] = z;
  }

  const region = new Uint8Array(nV);
  const regionData = pick('region') ?? pick('Region') ?? pick('label');
  if (regionData) regionData.forEach((r, i) => (region[i] = r >= 0 && r < REGIONS.length ? Math.round(r) : 0));
  else warnings.push('No region labels supplied; all vertices Unlabeled');

  const thicknessData = pick('wallThickness') ?? pick('wall_thickness') ?? pick('thickness');
  const wallThickness = thicknessData ?? Float32Array.from(region, (r) => REGIONS[r]!.thickness);
  if (!thicknessData) warnings.push('No wall thickness supplied; using per-region defaults');

  const q = meshQuality(positions, indices);
  if (q.nonManifoldEdges > 0) warnings.push(`${q.nonManifoldEdges} non-manifold edges`);
  if (q.duplicateHalfEdges > 0) warnings.push(`${q.duplicateHalfEdges} inconsistently oriented edges`);
  if (q.meanEdge < 0.5 || q.meanEdge > 2) warnings.push(`Mean edge ${q.meanEdge.toFixed(2)} mm is far from the ~1 mm the solver is calibrated for`);

  const loops: BoundaryLoop[] = boundaryLoops(indices).map((l, i) => ({
    label: inferLoopLabel(l, region) ?? `loop${i}`,
    vertices: Uint32Array.from(l),
  }));

  // Orientation: normals should point out of the blood pool. Use the signed volume heuristic.
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t]!, b = 3 * indices[t + 1]!, c = 3 * indices[t + 2]!;
    vol += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  if (vol < 0) {
    for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!];
    warnings.push('Flipped triangle winding so normals point outward');
  }

  vertexAdjacency(indices, nV); // validates indices are in range (throws on corrupt data)
  return {
    mesh: { positions, indices, normals: computeVertexNormals(positions, indices), region, wallThickness, boundaryLoops: loops },
    warnings,
  };
}

function inferLoopLabel(loop: number[], region: Uint8Array): string | null {
  const counts = new Map<number, number>();
  for (const v of loop) counts.set(region[v]!, (counts.get(region[v]!) ?? 0) + 1);
  let best = -1, bestN = 0;
  for (const [r, n] of counts) if (n > bestN) { best = r; bestN = n; }
  const pv = PV_REGIONS.indexOf(best as (typeof PV_REGIONS)[number]);
  if (pv >= 0) return PV_NAMES[pv]!;
  if (best === Region.MitralAnnulus || best === Region.MitralIsthmus) return 'MV';
  return null;
}

export function makeSidecar(mesh: SurfaceMesh): LabelSidecar {
  return {
    format: 'ostium-labels/1',
    units: 'mm',
    region: Array.from(mesh.region),
    wallThickness: Array.from(mesh.wallThickness, (t) => Math.round(t * 1000) / 1000),
  };
}
