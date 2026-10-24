import { add, cross, dot, normalize, perpendicular, scale, sub, type Vec3 } from '../math/vec3';
import { Rng } from '../rng';

/**
 * Roving mapping/ablation catheter (MODEL.md §3.2): a 3.5 mm tip and three 1 mm ring electrodes.
 * Contact force F (g) sets the gap between tip and tissue; the contact angle tilts the catheter
 * from perpendicular towards an azimuth in the tangent plane; a motion model adds cardiac,
 * respiratory and drift displacement that shrinks with firmer contact.
 */
export type CatheterType = 'ablation' | 'grid';

export interface RovingConfig {
  /** Mapping catheter: 4-electrode ablation catheter or 16-electrode HD grid. */
  type: CatheterType;
  /** Target contact force, g. */
  force: number;
  /** Angle between the catheter axis and the wall normal, degrees (0 = perpendicular). */
  angle: number;
  /** Direction of the tilt in the tangent plane, degrees. */
  azimuth: number;
  /** Edge-to-edge gaps tip–ring2, ring2–ring3, ring3–ring4 (mm). */
  spacing: [number, number, number];
}

export const DEFAULT_ROVING: RovingConfig = { type: 'ablation', force: 15, angle: 30, azimuth: 0, spacing: [2, 5, 2] };
export const SPACING_OPTIONS: Array<[number, number, number]> = [[2, 5, 2], [1, 6, 1], [2, 2, 2], [1, 4, 1]];

export const TIP_LENGTH = 3.5;
export const RING_LENGTH = 1;
export const CATHETER_RADIUS = 1.2;

/** Gap (mm) between the tip end and the tissue for contact force F (g): 3 mm floating, ~0 at ≥ 15 g. */
export function contactGap(force: number): number {
  return 3 * Math.exp(-Math.max(0, force) / 4);
}

/** Distances of electrode centres from the tip end along the axis (mm). */
export function electrodeOffsets(spacing: [number, number, number]): number[] {
  const tip = TIP_LENGTH / 2;
  const r2 = TIP_LENGTH + spacing[0] + RING_LENGTH / 2;
  const r3 = r2 + RING_LENGTH / 2 + spacing[1] + RING_LENGTH / 2;
  const r4 = r3 + RING_LENGTH / 2 + spacing[2] + RING_LENGTH / 2;
  return [tip, r2, r3, r4];
}

export interface RovingPose {
  /** Point on the endocardium the catheter is aimed at. */
  contact: Vec3;
  /** Outward wall normal at the contact point. */
  normal: Vec3;
  /** Unit vector from the tip back along the shaft (into the blood pool). */
  axis: Vec3;
  /** Tip end position. */
  tipEnd: Vec3;
  /** Electrode centres (tip, ring 2, ring 3, ring 4). */
  electrodes: Vec3[];
  /** Instantaneous contact force, g. */
  force: number;
  gap: number;
}

export function catheterAxis(normal: Vec3, angleDeg: number, azimuthDeg: number): Vec3 {
  const inward = scale(normal, -1);
  const t1 = perpendicular(normal);
  const t2 = cross(normal, t1);
  const az = (azimuthDeg * Math.PI) / 180, an = (angleDeg * Math.PI) / 180;
  const tilt = add(scale(t1, Math.cos(az)), scale(t2, Math.sin(az)));
  return normalize(add(scale(inward, Math.cos(an)), scale(tilt, Math.sin(an))));
}

export function rovingPose(contact: Vec3, normal: Vec3, cfg: RovingConfig, force = cfg.force, displacement: Vec3 = [0, 0, 0]): RovingPose {
  const axis = catheterAxis(normal, cfg.angle, cfg.azimuth);
  const gap = contactGap(force);
  // The tip end sits `gap` off the wall along the inward normal; a tilted tip touches with its edge.
  const tilt = Math.acos(Math.min(1, Math.max(-1, -dot(axis, normal))));
  const edgeLift = CATHETER_RADIUS * Math.sin(tilt);
  const tipEnd = add(add(contact, scale(normal, -(gap + edgeLift))), displacement);
  const electrodes = electrodeOffsets(cfg.spacing).map((s) => add(tipEnd, scale(axis, s)));
  return { contact, normal, axis, tipEnd, electrodes, force, gap };
}

/**
 * Tip motion: cardiac (heart-rate sinusoid), respiratory (0.25 Hz) and Ornstein–Uhlenbeck drift
 * displacements whose amplitudes fall with contact force; the force itself fluctuates with the
 * cardiac cycle and noise. Deterministic for a given seed.
 */
export class TipMotion {
  private rng: Rng;
  private drift: Vec3 = [0, 0, 0];
  private forceNoise = 0;
  private lastT = 0;
  private respDir: Vec3;
  private cardDir: Vec3;
  /** Recent tip positions (mm) and forces for the stability readout. */
  history: Array<{ t: number; p: Vec3; f: number }> = [];

  constructor(seed: number, normal: Vec3) {
    this.rng = new Rng(seed);
    const t1 = perpendicular(normal);
    this.respDir = normalize(add(t1, scale(normal, 0.3)));
    this.cardDir = normalize(add(cross(normal, t1), scale(normal, 0.5)));
  }

  /** Advance to time t (ms) and return the displacement and instantaneous force. */
  update(t: number, setForce: number, cycleLength: number): { displacement: Vec3; force: number } {
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const settle = Math.exp(-setForce / 15);
    const cl = cycleLength > 0 ? cycleLength : 800;
    const card = (1.2 * settle + 0.2) * Math.sin((2 * Math.PI * t) / cl);
    const resp = (2.0 * settle + 0.3) * Math.sin((2 * Math.PI * t) / 4000);
    // OU drift, τ = 2 s, stationary SD 0.6·settle + 0.1 mm.
    const tau = 2000, sd = 0.6 * settle + 0.1;
    const a = Math.exp(-dt / tau), b = sd * Math.sqrt(1 - a * a);
    this.drift = [a * this.drift[0] + b * this.rng.normal(), a * this.drift[1] + b * this.rng.normal(), a * this.drift[2] + b * this.rng.normal()];
    const displacement = add(add(scale(this.cardDir, card), scale(this.respDir, resp)), this.drift);
    // Force: cardiac modulation ±30 %, respiratory ±15 %, OU noise (τ 0.5 s).
    const fa = Math.exp(-dt / 500);
    this.forceNoise = fa * this.forceNoise + (1.5 + 0.1 * setForce) * Math.sqrt(1 - fa * fa) * this.rng.normal();
    const force = Math.max(0, setForce * (1 + 0.3 * Math.sin((2 * Math.PI * t) / cl) + 0.15 * Math.sin((2 * Math.PI * t) / 4000)) + this.forceNoise);
    this.history.push({ t, p: displacement, f: force });
    while (this.history.length && this.history[0]!.t < t - 1000) this.history.shift();
    return { displacement, force };
  }

  /** SD of tip position over the last second (mm) and force statistics (g). */
  stability(): { positionSd: number; forceMean: number; forceMin: number; forceMax: number } {
    const h = this.history;
    if (!h.length) return { positionSd: 0, forceMean: 0, forceMin: 0, forceMax: 0 };
    const m = h.reduce((s, x) => add(s, x.p), [0, 0, 0] as Vec3).map((x) => x / h.length) as Vec3;
    const v = h.reduce((s, x) => s + dot(sub(x.p, m), sub(x.p, m)), 0) / h.length;
    const fs = h.map((x) => x.f);
    return { positionSd: Math.sqrt(v), forceMean: fs.reduce((a, b) => a + b, 0) / fs.length, forceMin: Math.min(...fs), forceMax: Math.max(...fs) };
  }
}

/** Stability criteria used for the readout (and auto-acquire in M4). */
export function isStable(s: { positionSd: number; forceMin: number; forceMax: number }): boolean {
  return s.positionSd < 1.0 && s.forceMin >= 5 && s.forceMax <= 40;
}
