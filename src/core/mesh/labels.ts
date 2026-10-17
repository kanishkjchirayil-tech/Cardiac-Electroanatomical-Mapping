import { add, dot, len, scale, sub, getV, type Vec3 } from '../math/vec3';
import { edgeDijkstra } from './geodesic';
import { PV_ANTRUM_REGIONS, PV_REGIONS, Region } from './regions';
import type { AtriumShape } from './sdf-atrium';
import type { Adjacency } from './topology';
import type { AnatomyLandmarks, BoundaryLoop, PvLandmark } from './types';

export interface LabelOptions {
  /** Geodesic width of each PV antrum beyond the ostium, mm. */
  antrumWidth: number;
  /** Geodesic width of the mitral annulus band, mm. */
  mitralBand: number;
  /** Mitral isthmus = vertices with d(LIPV ostium) + d(MV) ≤ min + slack, mm. */
  isthmusSlack: number;
  /** Radial tolerance for vein-sleeve membership, mm. */
  veinRadialMargin: number;
  /** Ostium detection: funnel radius within this many mm of the tube radius. */
  ostiumTolerance: number;
}

export const DEFAULT_LABEL_OPTIONS: LabelOptions = {
  antrumWidth: 10,
  mitralBand: 6,
  isthmusSlack: 2,
  veinRadialMargin: 3,
  ostiumTolerance: 0.75,
};

export interface LabelResult {
  region: Uint8Array;
  /** Distance beyond the ostium along the vein axis (mm) for PV-sleeve vertices, else 0. */
  veinDepth: Float32Array;
  landmarks: AnatomyLandmarks;
}

/**
 * Rule-based anatomical segmentation of the procedural atrium. Precedence:
 * PV sleeve > LAA > mitral isthmus > mitral annulus > PV antrum > body wall segment.
 * See MODEL.md §1.3.
 */
export function labelAtrium(
  positions: Float32Array,
  _indices: Uint32Array,
  adj: Adjacency,
  loops: BoundaryLoop[],
  shape: AtriumShape,
  options: Partial<LabelOptions> = {},
): LabelResult {
  const o = { ...DEFAULT_LABEL_OPTIONS, ...options };
  const nV = positions.length / 3;
  const region = new Uint8Array(nV);
  const veinDepth = new Float32Array(nV);
  const veinOf = new Int8Array(nV).fill(-1);
  const tOst = shape.veins.map((_, k) => shape.ostiumT(k, o.ostiumTolerance));

  // 1. PV sleeves (distal to the ostium).
  for (let v = 0; v < nV; v++) {
    const p = getV(positions, v);
    shape.veins.forEach((vein, k) => {
      const rel = sub(p, vein.attach);
      const t = dot(rel, vein.axis);
      const radial = len(sub(rel, scale(vein.axis, t)));
      if (t >= tOst[k]! && radial < vein.radiusAt(t) + o.veinRadialMargin) {
        veinOf[v] = k;
        veinDepth[v] = t - tOst[k]!;
      }
    });
  }

  // 2. LAA by primitive ownership.
  const isLaa = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) {
    if (veinOf[v]! >= 0) continue;
    const p = getV(positions, v);
    const fl = shape.laa(p);
    let owner = fl < shape.body(p);
    for (let k = 0; k < shape.veins.length && owner; k++) if (shape.vein(k, p) < fl) owner = false;
    if (owner) isLaa[v] = 1;
  }

  // Ostium rings: sleeve vertices adjacent to non-sleeve vertices.
  const rings: number[][] = shape.veins.map(() => []);
  for (let v = 0; v < nV; v++) {
    const k = veinOf[v]!;
    if (k < 0) continue;
    for (let j = adj.offsets[v]!; j < adj.offsets[v + 1]!; j++) {
      if (veinOf[adj.neighbors[j]!] !== k) {
        rings[k]!.push(v);
        break;
      }
    }
  }

  const mvLoop = loops.find((l) => l.label === 'MV');
  const dMv = mvLoop ? edgeDijkstra(positions, adj, mvLoop.vertices).distance : new Float64Array(nV).fill(Infinity);

  // 3. Antra: geodesic Voronoi around the ostium rings.
  const ringSources: number[] = [];
  const ringPv: number[] = [];
  rings.forEach((r, k) => r.forEach((v) => { ringSources.push(v); ringPv.push(k); }));
  const antra = edgeDijkstra(positions, adj, ringSources, o.antrumWidth);

  // 4. Mitral isthmus: band around the shortest LIPV-ostium → annulus path.
  const lipv = shape.veins.findIndex((v) => v.name === 'LIPV');
  const dLipv = edgeDijkstra(positions, adj, rings[lipv] ?? []).distance;
  let dMin = Infinity;
  for (let v = 0; v < nV; v++) dMin = Math.min(dMin, dLipv[v]! + dMv[v]!);

  const c = shape.center, r = shape.params.bodyRadii;
  for (let v = 0; v < nV; v++) {
    const k = veinOf[v]!;
    if (k >= 0) { region[v] = PV_REGIONS[k]!; continue; }
    if (isLaa[v]) { region[v] = Region.LAA; continue; }
    if (dLipv[v]! + dMv[v]! <= dMin + o.isthmusSlack) { region[v] = Region.MitralIsthmus; continue; }
    if (dMv[v]! <= o.mitralBand) { region[v] = Region.MitralAnnulus; continue; }
    const src = antra.nearestSource[v]!;
    if (src >= 0 && antra.distance[v]! <= o.antrumWidth) { region[v] = PV_ANTRUM_REGIONS[ringPv[src]!]!; continue; }
    region[v] = bodySegment(getV(positions, v), c, r);
  }

  const pvs: PvLandmark[] = shape.veins.map((vein, k) => ({
    name: vein.name,
    ostiumCenter: add(vein.attach, scale(vein.axis, tOst[k]!)),
    axis: vein.axis,
    ostiumRadius: vein.radiusAt(tOst[k]!),
    ostiumRing: Uint32Array.from(rings[k]!),
  }));
  let mvCenter: Vec3 = [0, 0, 0], mvRadius = 0;
  if (mvLoop) {
    for (const v of mvLoop.vertices) mvCenter = add(mvCenter, getV(positions, v));
    mvCenter = scale(mvCenter, 1 / mvLoop.vertices.length);
    for (const v of mvLoop.vertices) mvRadius += len(sub(getV(positions, v), mvCenter)) / mvLoop.vertices.length;
  }
  return {
    region,
    veinDepth,
    landmarks: {
      bodyCenter: c,
      bodyRadii: r,
      pvs,
      mitral: { center: mvCenter, normal: shape.mitralNormal, radius: mvRadius },
      laa: { base: shape.laaBase, axis: shape.laaAxis },
    },
  };
}

/** Body wall segment by the dominant component of the ellipsoid-normalized position. */
export function bodySegment(p: Vec3, c: Vec3, r: Vec3): Region {
  const q = [(p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]];
  const scores: Array<[Region, number]> = [
    [Region.Lateral, q[0]!],
    [Region.Septum, -q[0]!],
    [Region.Posterior, q[1]!],
    [Region.Anterior, -q[1]!],
    [Region.Roof, q[2]!],
    [Region.Inferior, -q[2]!],
  ];
  let best = scores[0]!;
  for (const s of scores) if (s[1] > best[1]) best = s;
  return best[0];
}
