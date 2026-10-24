import type { Vec3 } from '../math/vec3';
import type { GeodesicFmm } from '../mesh/fmm';

/**
 * Empirical RF lesion model (MODEL.md §5.1). All parameters are educational, chosen so that
 * standard settings (30 W, 30 s, 10–20 g) give ≈ 3–4 mm deep, ≈ 7 mm wide lesions and
 * high-power short-duration settings give wider-but-shallower lesions, as reported
 * qualitatively in ex-vivo and clinical studies. They are not fitted to a specific dataset.
 *
 *   coupling       c(F)  = 1 − exp(−F / F_c)
 *   effective dose E     = ∫ P(t) · c(F(t)) dt                       (J)
 *   depth          D     = D_max · (1 − exp(−E / E_d))               (mm)
 *   diameter       W     = W_max · (1 − exp(−E · √(P / P_ref) / E_w)) (mm)
 *   quality index  LQI   = 10 · D / wall thickness                  (10 ⇔ predicted transmural)
 */
export interface LesionModelParams {
  forceScale: number;
  depthMax: number;
  depthEnergy: number;
  diameterMax: number;
  diameterEnergy: number;
  refPower: number;
  /** Width of the border zone outside the lesion edge, mm. */
  borderWidth: number;
  /** Conductivity multiplier in the border zone. */
  borderConductivity: number;
  /** EGM source multiplier in the border zone. */
  borderSource: number;
  /** Edema: extra radius (mm) and depth factor while active. */
  edemaRadius: number;
  edemaDepthFactor: number;
}

export const DEFAULT_LESION_MODEL: LesionModelParams = {
  forceScale: 10,
  depthMax: 6,
  depthEnergy: 900,
  diameterMax: 10,
  diameterEnergy: 600,
  refPower: 30,
  borderWidth: 2,
  borderConductivity: 0.6,
  borderSource: 0.8,
  edemaRadius: 2,
  edemaDepthFactor: 1.5,
};

export const contactCoupling = (force: number, p = DEFAULT_LESION_MODEL): number => 1 - Math.exp(-Math.max(0, force) / p.forceScale);

export function lesionSize(energy: number, power: number, p = DEFAULT_LESION_MODEL): { depth: number; diameter: number } {
  const depth = p.depthMax * (1 - Math.exp(-energy / p.depthEnergy));
  const diameter = p.diameterMax * (1 - Math.exp(-(energy * Math.sqrt(Math.max(power, 1) / p.refPower)) / p.diameterEnergy));
  return { depth, diameter };
}

export const lesionQuality = (depth: number, wallThickness: number): number => (10 * depth) / Math.max(0.3, wallThickness);

/** A delivered RF lesion. */
export interface Lesion {
  id: number;
  /** Contact point and vertex at the lesion centre. */
  center: Vec3;
  vertex: number;
  /** Delivered settings and measured exposure. */
  power: number;
  /** RF seconds delivered. */
  duration: number;
  energy: number;
  fti: number;
  meanForce: number;
  impedanceDrop: number;
  depth: number;
  diameter: number;
  /** Wall thickness at the centre, mm. */
  thickness: number;
  lqi: number;
  /** Peak estimated esophageal temperature during delivery, °C (NaN outside the esophageal zone). */
  esophagealTemp: number;
  /** Simulated time (ms) the lesion was (last) updated / finished. */
  time: number;
  /** Simulated time (ms) when edema resolves; −Infinity if none. */
  edemaUntil: number;
  /** Still being delivered. */
  active: boolean;
}

export interface LesionFields {
  core: Uint8Array;
  conductivity: Float32Array;
  source: Float32Array;
  /** 0 none, 1 border / partial thickness, 2 transmural core (teacher view). */
  kind: Uint8Array;
}

/**
 * Rasterize lesions onto the mesh. A lesion is an oblate half-ellipsoid of radius R = W/2 and
 * depth D: at surface (geodesic) distance s from the centre its depth is D·√(1 − (s/R)²).
 *  - depth ≥ local wall thickness → transmural core: inexcitable, no coupling, no EGM source;
 *  - 0 < depth < thickness → partial-thickness lesion: conduction preserved but slowed
 *    (σ × (1 − 0.6·d/t)) and the EGM source reduced to the viable fraction (1 − d/t);
 *  - R < s ≤ R + border → border zone (σ × 0.6, source × 0.8).
 * While edema is active, R grows by `edemaRadius` and D by `edemaDepthFactor`.
 */
export function rasterizeLesions(lesions: Lesion[], thickness: Float32Array, fmm: GeodesicFmm, positions: Float32Array, now: number, p = DEFAULT_LESION_MODEL): LesionFields {
  const n = thickness.length;
  const out: LesionFields = { core: new Uint8Array(n), conductivity: new Float32Array(n).fill(1), source: new Float32Array(n).fill(1), kind: new Uint8Array(n) };
  for (const L of lesions) {
    const edema = now < L.edemaUntil;
    const R = L.diameter / 2 + (edema ? p.edemaRadius : 0);
    const D = L.depth * (edema ? p.edemaDepthFactor : 1);
    if (R <= 0) continue;
    const f = fmm.local(L.vertex, [L.center[0], L.center[1], L.center[2]], R + p.borderWidth);
    void positions;
    for (let k = 0; k < f.idx.length; k++) {
      const v = f.idx[k]!, s = f.d[k]!;
      const t = thickness[v]!;
      if (s <= R) {
        const d = D * Math.sqrt(Math.max(0, 1 - (s / R) ** 2));
        if (d >= t) {
          out.core[v] = 1;
          out.kind[v] = 2;
          out.conductivity[v] = 0;
          out.source[v] = 0;
        } else {
          out.conductivity[v] = Math.min(out.conductivity[v]!, 1 - (0.6 * d) / t);
          out.source[v] = Math.min(out.source[v]!, 1 - d / t);
          out.kind[v] = Math.max(out.kind[v]!, 1);
        }
      } else {
        out.conductivity[v] = Math.min(out.conductivity[v]!, p.borderConductivity);
        out.source[v] = Math.min(out.source[v]!, p.borderSource);
        out.kind[v] = Math.max(out.kind[v]!, 1);
      }
    }
  }
  return out;
}

/** Centre-to-centre distance from each lesion to the previous one (NaN for the first). */
export function interLesionDistances(lesions: Array<Pick<Lesion, 'center'>>): number[] {
  return lesions.map((l, i) => {
    if (i === 0) return NaN;
    const q = lesions[i - 1]!.center;
    return Math.hypot(l.center[0] - q[0], l.center[1] - q[1], l.center[2] - q[2]);
  });
}

/**
 * A jump larger than this from the previous lesion is taken as the start of a new lesion set
 * (a new line or ring) rather than a gap in the current one, mm.
 */
export const NEW_SET_DISTANCE = 20;

/** Indices i (≥ 1) where lesion i is separated from lesion i − 1 by a gap: threshold < d ≤ NEW_SET_DISTANCE. */
export function lesionGaps(lesions: Array<Pick<Lesion, 'center'>>, threshold: number): number[] {
  return interLesionDistances(lesions).flatMap((d, i) => (d > threshold && d <= NEW_SET_DISTANCE ? [i] : []));
}
