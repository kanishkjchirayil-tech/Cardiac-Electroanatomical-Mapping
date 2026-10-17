import { add, cross, dot, len, normalize, scale, sub, type Vec3 } from '../math/vec3';
import { Rng } from '../rng';
import { PV_NAMES, type PvName } from './regions';

/**
 * Procedural left-atrium shape as an implicit surface f(p) = 0 (f < 0 inside the blood pool).
 * The body is an ellipsoid; pulmonary veins are tapered tubes and the LAA a bent two-segment
 * tube, all joined with a polynomial smooth-minimum which produces funnel-shaped antra and a
 * narrower LAA neck. f is a distance *bound*, not an exact SDF — projection uses Newton steps.
 * Dimensions are documented in MODEL.md §1.
 */

export interface PvParams {
  /** Direction from the body centre to the vein's attachment point on the ellipsoid. */
  attachDir: Vec3;
  /** Direction of the vein away from the atrium. */
  axis: Vec3;
  ostialRadius: number;
  distalRadius: number;
  /** Distance from the attachment point to the open (cut) end, mm. */
  cutDistance: number;
}

export interface AtriumParams {
  bodyRadii: Vec3;
  pvs: Record<PvName, PvParams>;
  /** Smooth-min radius between body and veins (sets antral funnel size), mm. */
  pvBlend: number;
  laa: {
    attachDir: Vec3;
    axis: Vec3;
    /** Direction of the distal (bent) LAA lobe. */
    tipAxis: Vec3;
    baseRadius: number;
    midRadius: number;
    tipRadius: number;
    proximalLength: number;
    distalLength: number;
    /** Smooth-min radius at the LAA neck, mm (smaller = more distinct ostium). */
    blend: number;
  };
  mitral: {
    /** Outward normal of the annulus plane (into the LV). */
    normal: Vec3;
    /** Plane offset as a fraction of the body's support distance along `normal`. */
    cutFraction: number;
  };
}

export const DEFAULT_ATRIUM: AtriumParams = {
  bodyRadii: [35, 24, 27],
  pvs: {
    LSPV: { attachDir: [0.55, 0.62, 0.52], axis: [0.62, 0.55, 0.56], ostialRadius: 9, distalRadius: 6.5, cutDistance: 20 },
    LIPV: { attachDir: [0.55, 0.7, -0.42], axis: [0.64, 0.6, -0.48], ostialRadius: 8.5, distalRadius: 6, cutDistance: 20 },
    RSPV: { attachDir: [-0.5, 0.64, 0.55], axis: [-0.55, 0.52, 0.65], ostialRadius: 9, distalRadius: 6.5, cutDistance: 20 },
    RIPV: { attachDir: [-0.5, 0.74, -0.42], axis: [-0.62, 0.62, -0.47], ostialRadius: 8.5, distalRadius: 6, cutDistance: 20 },
  },
  pvBlend: 7,
  laa: {
    attachDir: [0.8, -0.4, 0.42],
    axis: [0.5, -0.78, 0.38],
    tipAxis: [0.3, -0.62, -0.72],
    baseRadius: 8,
    midRadius: 6.5,
    tipRadius: 4,
    proximalLength: 11,
    distalLength: 11,
    blend: 4,
  },
  mitral: { normal: [0.35, -0.7, -0.62], cutFraction: 0.83 },
};

/** Randomize anatomy around the defaults; amount 0 returns an exact copy. */
export function jitterAtrium(base: AtriumParams, seed: number, amount: number): AtriumParams {
  const p: AtriumParams = structuredClone(base);
  if (amount <= 0) return p;
  const rng = new Rng(seed);
  const j = (sd: number) => 1 + rng.normal(0, sd * amount);
  const jd = (d: Vec3, sd: number): Vec3 =>
    normalize([d[0] + rng.normal(0, sd * amount), d[1] + rng.normal(0, sd * amount), d[2] + rng.normal(0, sd * amount)]);
  p.bodyRadii = [p.bodyRadii[0] * j(0.06), p.bodyRadii[1] * j(0.06), p.bodyRadii[2] * j(0.06)];
  for (const n of PV_NAMES) {
    const v = p.pvs[n];
    v.attachDir = jd(v.attachDir, 0.05);
    v.axis = jd(v.axis, 0.08);
    const r = j(0.08);
    v.ostialRadius *= r;
    v.distalRadius *= r;
  }
  p.laa.axis = jd(p.laa.axis, 0.08);
  p.laa.tipAxis = jd(p.laa.tipAxis, 0.15);
  p.mitral.normal = jd(p.mitral.normal, 0.04);
  return p;
}

export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Ellipsoid distance bound (Quilez). */
function sdEllipsoid(x: number, y: number, z: number, r: Vec3): number {
  const k0 = Math.hypot(x / r[0], y / r[1], z / r[2]);
  const k1 = Math.hypot(x / (r[0] * r[0]), y / (r[1] * r[1]), z / (r[2] * r[2]));
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(r[0], r[1], r[2]);
}

/** Tube along a+t·d, t∈[t0,t1], with radius profile r(t). Scalar, allocation-free (hot path). */
function sdTube(px: number, py: number, pz: number, a: Vec3, d: Vec3, t0: number, t1: number, r: (t: number) => number): number {
  const rx = px - a[0], ry = py - a[1], rz = pz - a[2];
  const t = Math.min(t1, Math.max(t0, rx * d[0] + ry * d[1] + rz * d[2]));
  return Math.hypot(rx - d[0] * t, ry - d[1] * t, rz - d[2] * t) - r(t);
}

export interface CutPlane {
  label: string;
  point: Vec3;
  normal: Vec3;
  /** Only geometry within this distance of the line (point, normal) is removed. */
  radius: number;
}

export interface VeinGeom {
  name: PvName;
  attach: Vec3;
  axis: Vec3;
  ostialRadius: number;
  distalRadius: number;
  cutDistance: number;
  radiusAt(t: number): number;
}

const TAPER_LENGTH = 10;
const VEIN_START = -6;

export class AtriumShape {
  readonly params: AtriumParams;
  readonly center: Vec3 = [0, 0, 0];
  readonly veins: VeinGeom[];
  readonly laaBase: Vec3;
  readonly laaAxis: Vec3;
  readonly laaTipAxis: Vec3;
  readonly mitralNormal: Vec3;
  readonly mitralOffset: number;
  readonly cuts: CutPlane[];
  private readonly laaElbow: Vec3;
  private readonly laaProximalRadius: (t: number) => number;
  private readonly laaDistalRadius: (t: number) => number;

  constructor(params: AtriumParams = DEFAULT_ATRIUM) {
    this.params = params;
    const r = params.bodyRadii;
    const onBody = (dir: Vec3): Vec3 => {
      const u = normalize(dir);
      const s = 1 / Math.hypot(u[0] / r[0], u[1] / r[1], u[2] / r[2]);
      return scale(u, s);
    };
    this.veins = PV_NAMES.map((name) => {
      const v = params.pvs[name];
      const r0 = v.ostialRadius, r1 = v.distalRadius;
      return {
        name,
        attach: onBody(v.attachDir),
        axis: normalize(v.axis),
        ostialRadius: r0,
        distalRadius: r1,
        cutDistance: v.cutDistance,
        radiusAt: (t: number) => (t <= 0 ? r0 : t >= TAPER_LENGTH ? r1 : r0 + ((r1 - r0) * t) / TAPER_LENGTH),
      };
    });
    this.laaBase = onBody(params.laa.attachDir);
    this.laaAxis = normalize(params.laa.axis);
    this.laaTipAxis = normalize(params.laa.tipAxis);
    const L = params.laa;
    this.laaElbow = add(this.laaBase, scale(this.laaAxis, L.proximalLength));
    this.laaProximalRadius = (t) => L.baseRadius + ((L.midRadius - L.baseRadius) * Math.max(0, t)) / L.proximalLength;
    this.laaDistalRadius = (t) => L.midRadius * 0.92 + ((L.tipRadius - L.midRadius * 0.92) * t) / L.distalLength;
    this.mitralNormal = normalize(params.mitral.normal);
    const n = this.mitralNormal;
    const support = Math.hypot(n[0] * r[0], n[1] * r[1], n[2] * r[2]);
    this.mitralOffset = params.mitral.cutFraction * support;
    // Approximate annulus radius from the central section, for the cut cylinder.
    const central = Math.sqrt(1 - params.mitral.cutFraction ** 2) * Math.max(r[0], r[1], r[2]);
    this.cuts = [
      ...this.veins.map((v) => ({
        label: v.name,
        point: add(v.attach, scale(v.axis, v.cutDistance)),
        normal: v.axis,
        radius: v.distalRadius + 5,
      })),
      { label: 'MV', point: scale(n, this.mitralOffset), normal: n, radius: central + 8 },
    ];
  }

  body(p: Vec3): number {
    return this.bodyXYZ(p[0], p[1], p[2]);
  }

  vein(i: number, p: Vec3): number {
    return this.veinXYZ(i, p[0], p[1], p[2]);
  }

  laa(p: Vec3): number {
    return this.laaXYZ(p[0], p[1], p[2]);
  }

  /** Full implicit function. */
  f(p: Vec3): number {
    return this.fXYZ(p[0], p[1], p[2]);
  }

  private bodyXYZ(x: number, y: number, z: number): number {
    return sdEllipsoid(x - this.center[0], y - this.center[1], z - this.center[2], this.params.bodyRadii);
  }

  private veinXYZ(i: number, x: number, y: number, z: number): number {
    const v = this.veins[i]!;
    return sdTube(x, y, z, v.attach, v.axis, VEIN_START, v.cutDistance + 8, v.radiusAt);
  }

  private laaXYZ(x: number, y: number, z: number): number {
    const L = this.params.laa;
    const a = sdTube(x, y, z, this.laaBase, this.laaAxis, -4, L.proximalLength, this.laaProximalRadius);
    const b = sdTube(x, y, z, this.laaElbow, this.laaTipAxis, 0, L.distalLength, this.laaDistalRadius);
    return smin(a, b, 3);
  }

  fXYZ(x: number, y: number, z: number): number {
    let d = this.bodyXYZ(x, y, z);
    for (let i = 0; i < this.veins.length; i++) d = smin(d, this.veinXYZ(i, x, y, z), this.params.pvBlend);
    return smin(d, this.laaXYZ(x, y, z), this.params.laa.blend);
  }

  gradient(p: Vec3, h = 1e-3): Vec3 {
    const [x, y, z] = p;
    const fx = this.fXYZ(x + h, y, z) - this.fXYZ(x - h, y, z);
    const fy = this.fXYZ(x, y + h, z) - this.fXYZ(x, y - h, z);
    const fz = this.fXYZ(x, y, z + h) - this.fXYZ(x, y, z - h);
    return [fx / (2 * h), fy / (2 * h), fz / (2 * h)];
  }

  normal(p: Vec3): Vec3 {
    return normalize(this.gradient(p));
  }

  /** Newton projection onto f = 0. */
  project(p: Vec3, iterations = 6): Vec3 {
    let [x, y, z] = p;
    const h = 1e-3;
    for (let i = 0; i < iterations; i++) {
      const f = this.fXYZ(x, y, z);
      if (Math.abs(f) < 1e-6) break;
      const gx = (this.fXYZ(x + h, y, z) - this.fXYZ(x - h, y, z)) / (2 * h);
      const gy = (this.fXYZ(x, y + h, z) - this.fXYZ(x, y - h, z)) / (2 * h);
      const gz = (this.fXYZ(x, y, z + h) - this.fXYZ(x, y, z - h)) / (2 * h);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (g2 < 1e-12) break;
      x -= (gx * f) / g2;
      y -= (gy * f) / g2;
      z -= (gz * f) / g2;
    }
    return [x, y, z];
  }

  /** Project onto the intersection curve of the surface with cut plane `c` (alternating projections). */
  projectToCut(p: Vec3, c: number): Vec3 {
    const cut = this.cuts[c]!;
    let q = p;
    for (let i = 0; i < 8; i++) {
      q = this.project(q, 4);
      q = sub(q, scale(cut.normal, dot(sub(q, cut.point), cut.normal)));
    }
    return q;
  }

  /**
   * Signed distance of p beyond cut c (positive = removed side), or -Infinity when p is outside
   * the cut's cylinder or belongs to a different primitive (so a cut never opens a neighbouring
   * structure, e.g. the MV plane clipping a strongly jittered LAA).
   */
  beyondCut(p: Vec3, c: number): number {
    const cut = this.cuts[c]!;
    const rel = sub(p, cut.point);
    const h = dot(rel, cut.normal);
    const radial = len(sub(rel, scale(cut.normal, h)));
    if (radial > cut.radius) return -Infinity;
    return this.owner(p) === c ? h : -Infinity;
  }

  /** Primitive nearest to p: vein index 0–3, 4 for the body (= MV cut index), 5 for the LAA. */
  owner(p: Vec3): number {
    let best = this.veins.length, bestD = this.body(p);
    for (let i = 0; i < this.veins.length; i++) {
      const d = this.vein(i, p);
      if (d < bestD) { bestD = d; best = i; }
    }
    return this.laa(p) < bestD ? this.veins.length + 1 : best;
  }

  /**
   * Mean surface radius around vein i at axial position t (from the attachment point),
   * measured by ray marching outward from the axis in 12 directions.
   */
  surfaceRadiusAround(i: number, t: number): number {
    const v = this.veins[i]!;
    const c = add(v.attach, scale(v.axis, t));
    const e1 = normalize(cross(v.axis, Math.abs(v.axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const e2 = cross(v.axis, e1);
    let sum = 0;
    const N = 12;
    for (let k = 0; k < N; k++) {
      const th = (2 * Math.PI * k) / N;
      const u: Vec3 = add(scale(e1, Math.cos(th)), scale(e2, Math.sin(th)));
      let lo = 0, hi = 0;
      for (let s = 0.25; s < 45; s += 0.25) {
        if (this.f(add(c, scale(u, s))) > 0) { hi = s; break; }
        lo = s;
      }
      if (hi === 0) { sum += 45; continue; }
      for (let it = 0; it < 20; it++) {
        const m = 0.5 * (lo + hi);
        if (this.f(add(c, scale(u, m))) > 0) hi = m; else lo = m;
      }
      sum += 0.5 * (lo + hi);
    }
    return sum / N;
  }

  /** Axial position of the ostium: where the antral funnel has narrowed to within `tol` mm of the tube. */
  ostiumT(i: number, tol = 0.75): number {
    const v = this.veins[i]!;
    for (let t = -2; t < v.cutDistance; t += 0.25) {
      if (this.surfaceRadiusAround(i, t) <= v.radiusAt(t) + tol) return t;
    }
    return v.cutDistance * 0.5;
  }

  bounds(margin = 4): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const grow = (p: Vec3, r: number) => {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[k]! - r);
        max[k] = Math.max(max[k]!, p[k]! + r);
      }
    };
    const r = this.params.bodyRadii;
    grow([-r[0], -r[1], -r[2]], 0);
    grow([r[0], r[1], r[2]], 0);
    for (const v of this.veins) grow(add(v.attach, scale(v.axis, v.cutDistance + 8)), v.ostialRadius);
    const L = this.params.laa;
    const elbow = add(this.laaBase, scale(this.laaAxis, L.proximalLength));
    grow(elbow, L.baseRadius);
    grow(add(elbow, scale(this.laaTipAxis, L.distalLength)), L.midRadius);
    for (let k = 0; k < 3; k++) {
      min[k] = min[k]! - margin - this.params.pvBlend;
      max[k] = max[k]! + margin + this.params.pvBlend;
    }
    return { min, max };
  }
}
