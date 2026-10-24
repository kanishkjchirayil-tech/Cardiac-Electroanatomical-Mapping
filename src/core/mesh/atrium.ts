import { dot, sub, type Vec3 } from '../math/vec3';
import { DynMesh, isotropicRemesh, type RemeshTarget } from './remesh';
import { AtriumShape, DEFAULT_ATRIUM, jitterAtrium, type AtriumParams, type CutPlane } from './sdf-atrium';
import { DEFAULT_RA, RaShape, jitterRa } from './sdf-ra';
import { labelRightAtrium } from './labels-ra';
import { surfaceNets } from './surface-nets';
import { boundaryLoops, computeVertexNormals, vertexAdjacency } from './topology';
import { labelAtrium, type LabelOptions } from './labels';
import { assignWallThickness, type ThicknessOptions } from './thickness';
import type { Chamber, SurfaceMesh } from './types';
import { meshQuality, type MeshQuality } from './quality';

export interface AtriumGenOptions {
  /** Which chamber to build (default LA; RA is the stretch goal, MODEL.md §8). */
  chamber?: Chamber;
  /** Anatomy shape parameters (defaults: DEFAULT_ATRIUM). */
  shape?: AtriumParams;
  /** Seed for anatomical variation and wall-thickness noise. */
  seed?: number;
  /** 0 = canonical anatomy; ~1 = typical inter-patient variation. */
  variability?: number;
  /** Target remeshing edge length, mm. */
  targetEdge?: number;
  /** Surface-nets grid spacing, mm. */
  gridSpacing?: number;
  remeshIterations?: number;
  labels?: Partial<LabelOptions>;
  thickness?: Partial<ThicknessOptions>;
  onProgress?: (stage: string, fraction: number) => void;
}

export interface AtriumGenResult {
  mesh: SurfaceMesh;
  shape: AtriumShape | RaShape;
  quality: MeshQuality;
  timingsMs: Record<string, number>;
}

export const DEFAULT_TARGET_EDGE = 0.95;

export function generateAtrium(opts: AtriumGenOptions = {}): AtriumGenResult {
  const seed = opts.seed ?? 1;
  const chamber = opts.chamber ?? 'LA';
  const shape = chamber === 'RA' ? new RaShape(jitterRa(DEFAULT_RA, seed, opts.variability ?? 0)) : new AtriumShape(jitterAtrium(opts.shape ?? DEFAULT_ATRIUM, seed, opts.variability ?? 0));
  const timings: Record<string, number> = {};
  const progress = opts.onProgress ?? (() => {});
  let t0 = performance.now();
  const lap = (name: string) => {
    const t = performance.now();
    timings[name] = t - t0;
    t0 = t;
  };

  progress('polygonize', 0);
  const { min, max } = shape.bounds();
  const nets = surfaceNets((x, y, z) => shape.fXYZ(x, y, z), min, max, opts.gridSpacing ?? 1.0);
  lap('polygonize');

  progress('cut', 0.15);
  const dyn = new DynMesh(nets.positions, nets.indices);
  cutOpenings(dyn, shape);
  lap('cut');

  progress('remesh', 0.25);
  const target: RemeshTarget = {
    projectSurface: (p) => shape.project(p),
    projectCurve: (p, c) => shape.projectToCut(p, c),
    normal: (p) => shape.normal(p),
  };
  isotropicRemesh(dyn, target, {
    targetEdge: opts.targetEdge ?? DEFAULT_TARGET_EDGE,
    iterations: opts.remeshIterations ?? 8,
  });
  lap('remesh');

  progress('label', 0.8);
  const arr = dyn.toArrays();
  const normals = computeVertexNormals(arr.positions, arr.indices);
  const nV = arr.positions.length / 3;
  const adj = vertexAdjacency(arr.indices, nV);
  const loopsRaw = boundaryLoops(arr.indices);
  const loops = loopsRaw.map((l) => {
    const c = arr.curve[l[0]!]!;
    return { label: c >= 0 ? shape.cuts[c]!.label : 'unknown', vertices: Uint32Array.from(l) };
  });
  // Stable loop order: PVs in canonical order, then MV.
  const order = shape.cuts.map((c) => c.label);
  loops.sort((x, y) => order.indexOf(x.label) - order.indexOf(y.label));

  const labels = shape instanceof RaShape ? labelRightAtrium(arr.positions, adj, loops, shape) : labelAtrium(arr.positions, arr.indices, adj, loops, shape, opts.labels);
  lap('label');
  const wallThickness = assignWallThickness(arr.positions, adj, labels.region, labels.veinDepth, seed, opts.thickness);
  lap('thickness');

  const mesh: SurfaceMesh = {
    positions: arr.positions,
    indices: arr.indices,
    normals,
    region: labels.region,
    wallThickness,
    boundaryLoops: loops,
    anatomy: labels.landmarks,
    chamber,
  };
  const quality = meshQuality(arr.positions, arr.indices);
  lap('quality');
  progress('done', 1);
  return { mesh, shape, quality, timingsMs: timings };
}

/**
 * Remove the closed tube ends beyond each cut plane, clean up non-manifold leftovers,
 * keep the largest component and snap boundary vertices onto the exact cut curves.
 */
/** What cutting and remeshing need from an implicit chamber shape. */
export interface CutShape {
  cuts: CutPlane[];
  beyondCut(p: Vec3, c: number): number;
  projectToCut(p: Vec3, c: number): Vec3;
}

export function cutOpenings(m: DynMesh, shape: CutShape): void {
  const centroid = (t: number): Vec3 => {
    const [a, b, c] = m.tri(t);
    const pa = m.pos(a), pb = m.pos(b), pc = m.pos(c);
    return [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
  };
  for (let t = 0; t < m.triangleCount; t++) {
    if (!m.triAlive(t)) continue;
    const c = centroid(t);
    for (let k = 0; k < shape.cuts.length; k++) {
      if (shape.beyondCut(c, k) > 0) {
        m.removeTri(t);
        break;
      }
    }
  }
  removeNonManifoldFans(m);
  keepLargestComponent(m);
  removeNonManifoldFans(m);

  // Assign each boundary loop to the nearest cut plane and snap it onto the cut curve.
  const idx: number[] = [];
  for (let t = 0; t < m.triangleCount; t++) if (m.triAlive(t)) idx.push(...m.tri(t));
  for (const loop of boundaryLoops(idx)) {
    // Tiny loops are holes left by bow-tie cleanup, not openings: close them with a fan
    // (reverse loop orientation so the new triangles agree with their neighbours).
    if (loop.length <= 8) {
      for (let i = 1; i + 1 < loop.length; i++) m.addTri(loop[0]!, loop[i + 1]!, loop[i]!);
      continue;
    }
    const votes = new Array(shape.cuts.length).fill(0);
    for (const v of loop) {
      const p = m.pos(v);
      let best = 0, bestD = Infinity;
      shape.cuts.forEach((cut, k) => {
        const d = Math.abs(dot(sub(p, cut.point), cut.normal));
        if (d < bestD && shape.beyondCut(p, k) > -Infinity) {
          bestD = d;
          best = k;
        }
      });
      votes[best]++;
    }
    const curve = votes.indexOf(Math.max(...votes));
    for (const v of loop) {
      m.curve[v] = curve;
      m.setPos(v, shape.projectToCut(m.pos(v), curve));
    }
  }
}

/** Delete triangles around vertices whose one-ring is not a single fan (bow-tie vertices). */
function removeNonManifoldFans(m: DynMesh): void {
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (let v = 0; v < m.vertexCount; v++) {
      if (!m.alive(v)) continue;
      let boundaryNbrs = 0;
      for (const c of m.neighborCounts(v).values()) {
        if (c === 1) boundaryNbrs++;
        if (c > 2) boundaryNbrs += 99;
      }
      if (boundaryNbrs > 2) {
        for (const t of [...m.vt[v]!]) m.removeTri(t);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function keepLargestComponent(m: DynMesh): void {
  const comp = new Int32Array(m.triangleCount).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < m.triangleCount; s++) {
    if (!m.triAlive(s) || comp[s] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const t = stack.pop()!;
      size++;
      for (const v of m.tri(t)) {
        for (const u of m.vt[v]!) {
          if (comp[u] === -1) {
            comp[u] = id;
            stack.push(u);
          }
        }
      }
    }
    sizes.push(size);
  }
  const keep = sizes.indexOf(Math.max(...sizes));
  for (let t = 0; t < m.triangleCount; t++) if (m.triAlive(t) && comp[t] !== keep) m.removeTri(t);
}
