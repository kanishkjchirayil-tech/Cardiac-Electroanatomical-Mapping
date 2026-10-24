import { add, getV, len, normalize, scale, sub, type Vec3 } from '../math/vec3';
import { edgeDijkstra } from './geodesic';
import { Region } from './regions';
import type { RaShape } from './sdf-ra';
import type { Adjacency } from './topology';
import type { AnatomyLandmarks, BoundaryLoop } from './types';

/**
 * Rule-based segmentation of the procedural right atrium (MODEL.md §8.1). Precedence:
 * SVC / IVC / CS ostium / RAA (by primitive ownership) > tricuspid annulus band > cavotricuspid
 * isthmus > crista terminalis > septum > posterior venous sinus > trabeculated free wall.
 */
export interface RaLabelOptions {
  /** Width of the tricuspid annulus band, mm. */
  annulusBand: number;
  /** CTI = inferior vertices with d(IVC) + d(TV) ≤ min + slack, lateral to the CS ostium, mm. */
  ctiSlack: number;
  /** Half-width of the crista terminalis band around its centreline, mm. */
  cristaHalfWidth: number;
}

export const DEFAULT_RA_LABELS: RaLabelOptions = { annulusBand: 5, ctiSlack: 9, cristaHalfWidth: 2.5 };

export function labelRightAtrium(positions: Float32Array, adj: Adjacency, loops: BoundaryLoop[], shape: RaShape, options: Partial<RaLabelOptions> = {}) {
  const o = { ...DEFAULT_RA_LABELS, ...options };
  const nV = positions.length / 3;
  const region = new Uint8Array(nV);
  const veinDepth = new Float32Array(nV);
  const owner = new Int8Array(nV);
  for (let v = 0; v < nV; v++) owner[v] = shape.owner(getV(positions, v));

  // Ostium rings of the tubes: tube-owned vertices next to body vertices.
  const ring = (k: number) => {
    const out: number[] = [];
    for (let v = 0; v < nV; v++) {
      if (owner[v] !== k) continue;
      for (let j = adj.offsets[v]!; j < adj.offsets[v + 1]!; j++) if (owner[adj.neighbors[j]!] !== k) { out.push(v); break; }
    }
    return out;
  };
  const rings = [ring(0), ring(1), ring(2)];
  shape.tubes.forEach((t, k) => {
    for (let v = 0; v < nV; v++) {
      if (owner[v] !== k) continue;
      const rel = sub(getV(positions, v), t.attach);
      veinDepth[v] = Math.max(0, rel[0] * t.axis[0] + rel[1] * t.axis[1] + rel[2] * t.axis[2]);
    }
  });
  const loop = (label: string) => loops.find((l) => l.label === label)?.vertices ?? new Uint32Array(0);
  const tv = loop('TV');
  const dTv = edgeDijkstra(positions, adj, tv).distance;
  const dIvc = edgeDijkstra(positions, adj, rings[1]!.length ? rings[1]! : loop('IVC')).distance;
  const dSvc = edgeDijkstra(positions, adj, rings[0]!.length ? rings[0]! : loop('SVC')).distance;
  const dCs = edgeDijkstra(positions, adj, rings[2]!.length ? rings[2]! : loop('CS')).distance;
  let dMin = Infinity;
  for (let v = 0; v < nV; v++) if (owner[v] === 3) dMin = Math.min(dMin, dIvc[v]! + dTv[v]!);
  const csCentre = shape.tubes[2]!.attach;

  // Crista terminalis: SVC ring → posterolateral waypoint → IVC ring, along mesh edges.
  const c = shape.center, r = shape.params.bodyRadii;
  const q = (v: number): Vec3 => [(positions[3 * v]! - c[0]) / r[0], (positions[3 * v + 1]! - c[1]) / r[1], (positions[3 * v + 2]! - c[2]) / r[2]];
  const wdir = normalize([-0.8, 0.55, 0]);
  let way = 0, ws = -Infinity;
  for (let v = 0; v < nV; v++) {
    if (owner[v] !== 3) continue;
    const p = q(v);
    const s = p[0] * wdir[0] + p[1] * wdir[1] + p[2] * wdir[2];
    if (s > ws) { ws = s; way = v; }
  }
  const pathFrom = (src: ArrayLike<number>, to: number): number[] => {
    const d = edgeDijkstra(positions, adj, src).distance;
    const out = [to];
    let cur = to;
    while (d[cur]! > 0) {
      let nx = cur;
      for (let j = adj.offsets[cur]!; j < adj.offsets[cur + 1]!; j++) if (d[adj.neighbors[j]!]! < d[nx]!) nx = adj.neighbors[j]!;
      if (nx === cur) break;
      out.push(nx);
      cur = nx;
    }
    return out; // from `to` back to the source set
  };
  const upper = pathFrom(rings[0]!, way).reverse(); // SVC → waypoint
  const lower = pathFrom(rings[1]!, way); // waypoint → IVC
  const crista = [...upper, ...lower.slice(1)];
  const dCrista = edgeDijkstra(positions, adj, crista, o.cristaHalfWidth + 1).distance;

  for (let v = 0; v < nV; v++) {
    const k = owner[v]!;
    if (k === 0) { region[v] = Region.SVC; continue; }
    if (k === 1) { region[v] = Region.IVC; continue; }
    if (k === 2) { region[v] = Region.CSOstium; continue; }
    if (k === 4) { region[v] = Region.RAA; continue; }
    if (dTv[v]! <= o.annulusBand) { region[v] = Region.TricuspidAnnulus; continue; }
    const p = getV(positions, v);
    if (dIvc[v]! + dTv[v]! <= dMin + o.ctiSlack && p[2] < c[2] && dCs[v]! > 4 && p[0] < csCentre[0] - 2) { region[v] = Region.CTI; continue; }
    if (dCrista[v]! <= o.cristaHalfWidth) { region[v] = Region.CristaTerminalis; continue; }
    const qq = q(v);
    if (qq[0] > 0.35) { region[v] = Region.RASeptum; continue; }
    if (qq[1] > 0.3 && qq[0] > -0.55) { region[v] = Region.RAPosterior; continue; }
    region[v] = Region.RAFreeWall;
  }

  // Sinus node: the first crista vertex at least 6 mm below the SVC junction.
  const sinusNode = crista.find((v) => dSvc[v]! >= 6) ?? crista[0]!;
  let tvCenter: Vec3 = [0, 0, 0], tvRadius = 0;
  for (const v of tv) tvCenter = add(tvCenter, getV(positions, v));
  if (tv.length) tvCenter = scale(tvCenter, 1 / tv.length);
  for (const v of tv) tvRadius += len(sub(getV(positions, v), tvCenter)) / Math.max(1, tv.length);
  const tube = (k: number) => {
    const t = shape.tubes[k]!;
    return { center: add(t.attach, scale(t.axis, 2)), axis: t.axis, radius: t.radius };
  };
  const landmarks: AnatomyLandmarks = {
    bodyCenter: c,
    bodyRadii: r,
    pvs: [],
    mitral: { center: tvCenter, normal: shape.tvNormal, radius: tvRadius },
    laa: { base: shape.raaBase, axis: shape.raaAxis },
    ra: { svc: tube(0), ivc: tube(1), csOs: tube(2), crista: Uint32Array.from(crista), sinusNode },
  };
  return { region, veinDepth, landmarks };
}
