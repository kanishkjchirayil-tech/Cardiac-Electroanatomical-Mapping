import { add, dot, len, normalize, scale, sub, type Vec3 } from '../math/vec3';
import { Rng } from '../rng';
import { sdEllipsoid, sdTube, smin, type CutPlane } from './sdf-atrium';

/**
 * Procedural right-atrium shape (stretch goal; MODEL.md §8.1), built like the LA (§1.2): an
 * ellipsoid body joined by smooth-min to tubes for the superior and inferior venae cavae and the
 * coronary-sinus ostium, and a broad two-segment RA appendage. The tricuspid annulus is a cut plane
 * facing the right ventricle (anterior, leftward, inferior). Frame: LPS mm, centred on the RA.
 */
export interface RaTube {
  attachDir: Vec3;
  axis: Vec3;
  radius: number;
  cutDistance: number;
}

export interface RaParams {
  bodyRadii: Vec3;
  svc: RaTube;
  ivc: RaTube;
  cs: RaTube;
  raa: { attachDir: Vec3; axis: Vec3; tipAxis: Vec3; baseRadius: number; midRadius: number; tipRadius: number; proximalLength: number; distalLength: number; blend: number };
  tv: { normal: Vec3; cutFraction: number };
  /** Smooth-min radius between the body and the caval/CS tubes, mm. */
  blend: number;
}

export const DEFAULT_RA: RaParams = {
  bodyRadii: [24, 22, 27],
  svc: { attachDir: [-0.1, 0.3, 0.95], axis: [-0.05, 0.2, 0.98], radius: 9.5, cutDistance: 18 },
  ivc: { attachDir: [-0.05, 0.62, -0.78], axis: [0, 0.5, -0.87], radius: 11.5, cutDistance: 16 },
  cs: { attachDir: [0.62, 0.2, -0.76], axis: [0.75, 0.35, -0.55], radius: 4.5, cutDistance: 9 },
  raa: { attachDir: [-0.45, -0.7, 0.55], axis: [-0.35, -0.8, 0.5], tipAxis: [-0.1, -0.7, 0.7], baseRadius: 11, midRadius: 8.5, tipRadius: 5.5, proximalLength: 10, distalLength: 9, blend: 6 },
  tv: { normal: [0.5, -0.84, -0.18], cutFraction: 0.74 },
  blend: 6,
};

export function jitterRa(base: RaParams, seed: number, amount: number): RaParams {
  const p: RaParams = structuredClone(base);
  if (amount <= 0) return p;
  const rng = new Rng(seed ^ 0x2a);
  const j = (sd: number) => 1 + rng.normal(0, sd * amount);
  const jd = (d: Vec3, sd: number): Vec3 => normalize([d[0] + rng.normal(0, sd * amount), d[1] + rng.normal(0, sd * amount), d[2] + rng.normal(0, sd * amount)]);
  p.bodyRadii = [p.bodyRadii[0] * j(0.06), p.bodyRadii[1] * j(0.06), p.bodyRadii[2] * j(0.06)];
  for (const t of [p.svc, p.ivc]) { t.axis = jd(t.axis, 0.06); t.radius *= j(0.08); }
  p.raa.axis = jd(p.raa.axis, 0.08);
  p.tv.normal = jd(p.tv.normal, 0.04);
  return p;
}

export const RA_CUTS = ['SVC', 'IVC', 'CS', 'TV'] as const;

export class RaShape {
  readonly params: RaParams;
  readonly center: Vec3 = [0, 0, 0];
  readonly tubes: Array<{ name: 'SVC' | 'IVC' | 'CS'; attach: Vec3; axis: Vec3; radius: number; cutDistance: number }>;
  readonly raaBase: Vec3;
  readonly raaAxis: Vec3;
  readonly tvNormal: Vec3;
  readonly tvOffset: number;
  readonly tvRadius: number;
  readonly cuts: CutPlane[];
  private readonly raaElbow: Vec3;
  private readonly raaTipAxis: Vec3;

  constructor(params: RaParams = DEFAULT_RA) {
    this.params = params;
    const r = params.bodyRadii;
    const onBody = (dir: Vec3): Vec3 => {
      const u = normalize(dir);
      return scale(u, 1 / Math.hypot(u[0] / r[0], u[1] / r[1], u[2] / r[2]));
    };
    this.tubes = (['SVC', 'IVC', 'CS'] as const).map((name) => {
      const t = params[name.toLowerCase() as 'svc' | 'ivc' | 'cs'];
      return { name, attach: onBody(t.attachDir), axis: normalize(t.axis), radius: t.radius, cutDistance: t.cutDistance };
    });
    this.raaBase = onBody(params.raa.attachDir);
    this.raaAxis = normalize(params.raa.axis);
    this.raaTipAxis = normalize(params.raa.tipAxis);
    this.raaElbow = add(this.raaBase, scale(this.raaAxis, params.raa.proximalLength));
    this.tvNormal = normalize(params.tv.normal);
    const n = this.tvNormal;
    const support = Math.hypot(n[0] * r[0], n[1] * r[1], n[2] * r[2]);
    this.tvOffset = params.tv.cutFraction * support;
    this.tvRadius = Math.sqrt(1 - params.tv.cutFraction ** 2) * Math.max(r[0], r[1], r[2]);
    this.cuts = [
      ...this.tubes.map((t) => ({ label: t.name, point: add(t.attach, scale(t.axis, t.cutDistance)), normal: t.axis, radius: t.radius + 5 })),
      { label: 'TV', point: scale(n, this.tvOffset), normal: n, radius: this.tvRadius + 8 },
    ];
  }

  body(p: Vec3): number {
    return sdEllipsoid(p[0] - this.center[0], p[1] - this.center[1], p[2] - this.center[2], this.params.bodyRadii);
  }

  tube(i: number, p: Vec3): number {
    return this.tubeXYZ(i, p[0], p[1], p[2]);
  }

  private tubeXYZ(i: number, x: number, y: number, z: number): number {
    const t = this.tubes[i]!;
    return sdTube(x, y, z, t.attach, t.axis, -6, t.cutDistance + 8, () => t.radius);
  }

  raa(p: Vec3): number {
    return this.raaXYZ(p[0], p[1], p[2]);
  }

  private raaXYZ(x: number, y: number, z: number): number {
    const L = this.params.raa;
    const a = sdTube(x, y, z, this.raaBase, this.raaAxis, -4, L.proximalLength, (t) => L.baseRadius + ((L.midRadius - L.baseRadius) * Math.max(0, t)) / L.proximalLength);
    const b = sdTube(x, y, z, this.raaElbow, this.raaTipAxis, 0, L.distalLength, (t) => L.midRadius * 0.92 + ((L.tipRadius - L.midRadius * 0.92) * t) / L.distalLength);
    return smin(a, b, 4);
  }

  fXYZ(x: number, y: number, z: number): number {
    let d = sdEllipsoid(x - this.center[0], y - this.center[1], z - this.center[2], this.params.bodyRadii);
    for (let i = 0; i < this.tubes.length; i++) d = smin(d, this.tubeXYZ(i, x, y, z), i === 2 ? 3 : this.params.blend);
    return smin(d, this.raaXYZ(x, y, z), this.params.raa.blend);
  }

  f(p: Vec3): number {
    return this.fXYZ(p[0], p[1], p[2]);
  }

  normal(p: Vec3, h = 1e-3): Vec3 {
    const [x, y, z] = p;
    return normalize([this.fXYZ(x + h, y, z) - this.fXYZ(x - h, y, z), this.fXYZ(x, y + h, z) - this.fXYZ(x, y - h, z), this.fXYZ(x, y, z + h) - this.fXYZ(x, y, z - h)]);
  }

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

  projectToCut(p: Vec3, c: number): Vec3 {
    const cut = this.cuts[c]!;
    let q = p;
    for (let i = 0; i < 8; i++) {
      q = this.project(q, 4);
      q = sub(q, scale(cut.normal, dot(sub(q, cut.point), cut.normal)));
    }
    return q;
  }

  /** Primitive nearest to p: 0 SVC, 1 IVC, 2 CS, 3 body (= TV cut), 4 RAA. */
  owner(p: Vec3): number {
    let best = 3, bestD = this.body(p);
    for (let i = 0; i < this.tubes.length; i++) {
      const d = this.tube(i, p);
      if (d < bestD) { bestD = d; best = i; }
    }
    return this.raa(p) < bestD ? 4 : best;
  }

  beyondCut(p: Vec3, c: number): number {
    const cut = this.cuts[c]!;
    const rel = sub(p, cut.point);
    const h = dot(rel, cut.normal);
    if (len(sub(rel, scale(cut.normal, h))) > cut.radius) return -Infinity;
    return this.owner(p) === c ? h : -Infinity;
  }

  bounds(margin = 4): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const grow = (p: Vec3, r: number) => {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[k]! - r); max[k] = Math.max(max[k]!, p[k]! + r); }
    };
    const r = this.params.bodyRadii;
    grow([-r[0], -r[1], -r[2]], 0);
    grow([r[0], r[1], r[2]], 0);
    for (const t of this.tubes) grow(add(t.attach, scale(t.axis, t.cutDistance + 8)), t.radius);
    const L = this.params.raa;
    grow(this.raaElbow, L.baseRadius);
    grow(add(this.raaElbow, scale(this.raaTipAxis, L.distalLength)), L.midRadius);
    for (let k = 0; k < 3; k++) { min[k] = min[k]! - margin - this.params.blend; max[k] = max[k]! + margin + this.params.blend; }
    return { min, max };
  }
}
