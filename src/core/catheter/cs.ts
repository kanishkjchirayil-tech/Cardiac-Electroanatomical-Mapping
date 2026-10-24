import { add, cross, dot, getV, len, normalize, scale, sub, type Vec3 } from '../math/vec3';
import type { SurfaceMesh } from '../mesh/types';

/**
 * Fixed decapolar coronary-sinus reference catheter (MODEL.md §3.2). The CS runs in the
 * posterior/inferior atrioventricular groove, epicardial to the LA, just atrial to the mitral
 * annulus. Electrode 10 (proximal) sits at the septal end near the CS ostium; electrode 1 (distal)
 * is lateral. Spacing 2-8-2 mm (centre to centre), as on a common decapolar.
 */
export interface CsCatheter {
  /** Electrode centres, index 0 = CS 1 (distal, lateral) … 9 = CS 10 (proximal, septal). */
  electrodes: Vec3[];
  /** Catheter centreline from the CS ostium (septal) to beyond the distal electrode. */
  path: Vec3[];
}

export const CS_SPACING = [2, 8, 2, 8, 2, 8, 2, 8, 2];

export interface CsOptions {
  /** Radial offset of the CS outside the annulus, mm. */
  radialOffset: number;
  /** Offset from the annulus plane towards the atrium, mm. */
  atrialOffset: number;
  /** Minimum clearance outside the epicardium (beyond wall thickness), mm. */
  clearance: number;
  /** Arc length from the ostium to the proximal electrode, mm. */
  proximalInset: number;
}

export const DEFAULT_CS: CsOptions = { radialOffset: 5, atrialOffset: 6, clearance: 1.5, proximalInset: 4 };

export function buildCsCatheter(mesh: SurfaceMesh, opts: Partial<CsOptions> = {}): CsCatheter {
  if (mesh.chamber === 'RA' && mesh.anatomy?.ra) return buildCsCatheterRa(mesh);
  const o = { ...DEFAULT_CS, ...opts };
  const loop = mesh.boundaryLoops.find((l) => l.label === 'MV');
  if (!loop) throw new Error('The mesh has no mitral annulus opening (MV boundary loop)');
  const P = mesh.positions;
  const pts = Array.from(loop.vertices, (v) => getV(P, v));
  const c: Vec3 = scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / pts.length);
  // Annulus plane normal pointing into the ventricle (away from the atrial centroid).
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) n = add(n, cross(sub(pts[i]!, c), sub(pts[(i + 1) % pts.length]!, c)));
  n = normalize(n);
  const meshCentroid = (() => {
    let s: Vec3 = [0, 0, 0];
    for (let i = 0; i < P.length / 3; i++) s = add(s, getV(P, i));
    return scale(s, 3 / P.length);
  })();
  if (dot(n, sub(c, meshCentroid)) < 0) n = scale(n, -1);
  const inPlane = (d: Vec3): Vec3 => normalize(sub(d, scale(n, dot(d, n))));
  // In-plane reference directions: posterior-inferior (where the CS runs) and septal (patient right).
  const post = inPlane([0, 0.7, -0.7]);
  const septal = inPlane([-1, 0, 0]);
  const w = normalize(cross(n, post));
  const sgn = dot(w, septal) > 0 ? 1 : -1; // angle direction that rotates towards the septum
  const dirAt = (deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180;
    return add(scale(post, Math.cos(a)), scale(w, sgn * Math.sin(a)));
  };
  // Annulus radius along a direction: furthest loop point within ±10° of it.
  const radiusAt = (d: Vec3): number => {
    let r = 0;
    for (const p of pts) {
      const q = sub(p, c);
      const qp = sub(q, scale(n, dot(q, n)));
      const l = len(qp);
      if (l > 0 && dot(qp, d) / l > Math.cos((10 * Math.PI) / 180)) r = Math.max(r, l);
    }
    return r || 15;
  };
  const nV = P.length / 3;
  const clearOutside = (p: Vec3): Vec3 => {
    // Push the point outside the epicardium of the nearest wall: (p − x_v)·n_v ≥ t_v + clearance.
    let best = 0, bd = Infinity;
    for (let i = 0; i < nV; i++) {
      const d = (P[3 * i]! - p[0]) ** 2 + (P[3 * i + 1]! - p[1]) ** 2 + (P[3 * i + 2]! - p[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const nv = getV(mesh.normals, best);
    const h = dot(sub(p, getV(P, best)), nv);
    const need = mesh.wallThickness[best]! + o.clearance;
    return h < need ? add(p, scale(nv, need - h)) : p;
  };
  // Centreline from the posteroseptal ostium (+55° towards the septum) round to the lateral wall.
  const path: Vec3[] = [];
  let arc = 0;
  const total = o.proximalInset + CS_SPACING.reduce((a, b) => a + b, 0) + 12;
  for (let deg = 55; deg > -200 && arc < total; deg -= 2) {
    const d = dirAt(deg);
    const p = clearOutside(add(add(c, scale(d, radiusAt(d) + o.radialOffset)), scale(n, -o.atrialOffset)));
    if (path.length) arc += len(sub(p, path[path.length - 1]!));
    path.push(p);
  }
  // Electrodes by arc length from the proximal end: CS 10 first.
  const at = (s: number): Vec3 => {
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const seg = len(sub(path[i]!, path[i - 1]!));
      if (acc + seg >= s) return add(path[i - 1]!, scale(sub(path[i]!, path[i - 1]!), (s - acc) / seg));
      acc += seg;
    }
    return path[path.length - 1]!;
  };
  const prox: Vec3[] = [];
  let s = o.proximalInset;
  prox.push(at(s));
  for (const gap of CS_SPACING) {
    s += gap;
    prox.push(at(s));
  }
  return { electrodes: prox.reverse(), path };
}

/**
 * Right-atrium chamber (MODEL.md §8.2): the CS catheter enters from the IVC, crosses the RA floor
 * and passes through the CS ostium. CS 9-10 lie in the ostium; the more distal electrodes continue
 * along the CS axis beyond the simulated chamber (the left-atrial AV groove is not modelled, so they
 * record only far-field RA activity).
 */
export function buildCsCatheterRa(mesh: SurfaceMesh): CsCatheter {
  const ra = mesh.anatomy!.ra!;
  const os = ra.csOs.center, ax = normalize(ra.csOs.axis);
  const ivc = ra.ivc.center, ivcAx = normalize(ra.ivc.axis);
  const body = mesh.anatomy!.bodyCenter;
  const floor: Vec3 = add(scale(add(ivc, os), 0.5), scale(sub(body, scale(add(ivc, os), 0.5)), 0.25));
  const path: Vec3[] = [add(ivc, scale(ivcAx, 25)), add(ivc, scale(ivcAx, 5)), floor, sub(os, scale(ax, 4))];
  const total = 3 + CS_SPACING.reduce((a, b) => a + b, 0) + 10;
  for (let s = 0; s <= total; s += 2) path.push(add(os, scale(ax, s)));
  // The catheter lies against the inferior wall of the CS: proximal electrodes 3.1 mm off the axis.
  const down = normalize(sub([0, 0, -1], scale(ax, -ax[2])));
  const at = (d: number): Vec3 => add(add(os, scale(ax, d)), scale(down, d < 10 ? 3.1 : 0));
  const prox: Vec3[] = [];
  let s = 1;
  prox.push(at(s));
  for (const gap of CS_SPACING) {
    s += gap;
    prox.push(at(s));
  }
  return { electrodes: prox.reverse(), path };
}
