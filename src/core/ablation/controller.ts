import type { SurfaceMesh } from '../mesh/types';
import type { Vec3 } from '../math/vec3';
import { GeodesicFmm } from '../mesh/fmm';
import { DEFAULT_LESION_MODEL, rasterizeLesions, type Lesion, type LesionFields, type LesionModelParams } from './lesion';
import { RfApplication, type RfReadout } from './rf';
import type { Substrate } from '../ep/substrate';

/** User-facing RF settings (MODEL.md §5). */
export interface AblationSettings {
  /** RF power, W. */
  power: number;
  /** Target RF duration, s. */
  duration: number;
  /**
   * RF seconds delivered per simulated second. Real RF lasts tens of seconds, which at the
   * solver's speed would be minutes of waiting, so the RF clock is accelerated (educational).
   */
  timeScale: number;
  /** Reversible edema around fresh lesions (acute block that later recovers). */
  edema: boolean;
  /** Simulated seconds until a lesion's edema resolves. */
  edemaRecoverySec: number;
  /** Interlesion distance above which a gap is flagged, mm. */
  gapThreshold: number;
}

export const DEFAULT_ABLATION: AblationSettings = {
  power: 35,
  duration: 20,
  timeScale: 10,
  edema: false,
  edemaRecoverySec: 30,
  gapThreshold: 6,
};

/** Simulated seconds of RF between re-rasterizations while a lesion grows. */
const GROWTH_UPDATE_S = 2;

/**
 * Owns the lesion set and the current RF application, and turns them into per-vertex fields
 * (lesion cores, conductivity and EGM-source multipliers). Framework-free; the simulation engine
 * applies the fields to the substrate, solver and lead fields whenever `rasterize` changes them.
 */
export class AblationController {
  lesions: Lesion[] = [];
  private rf: { app: RfApplication; lesion: Lesion; lastRaster: number } | null = null;
  private nextId = 1;
  private readonly fmm: GeodesicFmm;

  constructor(readonly mesh: SurfaceMesh, readonly esophagealZone: Uint8Array, readonly model: LesionModelParams = DEFAULT_LESION_MODEL) {
    this.fmm = new GeodesicFmm(mesh.positions, mesh.indices);
  }

  get active(): boolean {
    return this.rf !== null;
  }

  /** Begin RF at a contact vertex. `now` is the simulation time (ms). */
  start(vertex: number, center: Vec3, settings: AblationSettings, now: number): Lesion {
    this.stop(now);
    const thickness = this.mesh.wallThickness[vertex]!;
    const app = new RfApplication({ power: settings.power, duration: settings.duration }, thickness, this.esophagealZone[vertex] === 1, this.model);
    const lesion: Lesion = {
      id: this.nextId++,
      center: [...center],
      vertex,
      power: settings.power,
      duration: 0,
      energy: 0,
      fti: 0,
      meanForce: 0,
      impedanceDrop: 0,
      depth: 0,
      diameter: 0,
      thickness,
      lqi: 0,
      esophagealTemp: NaN,
      time: now,
      edemaUntil: -Infinity,
      active: true,
    };
    this.lesions.push(lesion);
    this.rf = { app, lesion, lastRaster: 0 };
    this.edema = settings.edema ? settings.edemaRecoverySec * 1000 : 0;
    return lesion;
  }

  private edema = 0;

  /**
   * Advance RF by `rfSeconds` at contact force `force`. Returns the readout and whether the lesion
   * fields should be re-rasterized (every GROWTH_UPDATE_S of RF and when the application ends).
   */
  step(rfSeconds: number, force: number, now: number): { readout: RfReadout; changed: boolean } | null {
    const rf = this.rf;
    if (!rf) return null;
    rf.app.step(rfSeconds, force);
    const readout = rf.app.readout();
    this.sync(rf.lesion, readout, now);
    let changed = false;
    if (readout.done) {
      this.stop(now);
      changed = true;
    } else if (rf.app.elapsed - rf.lastRaster >= GROWTH_UPDATE_S) {
      rf.lastRaster = rf.app.elapsed;
      changed = true;
    }
    return { readout, changed };
  }

  /** Deliver the whole application at once at a fixed force (used when the clock is paused, and in tests). */
  deliver(vertex: number, center: Vec3, settings: AblationSettings, force: number, now: number): Lesion {
    const lesion = this.start(vertex, center, settings, now);
    while (this.rf) this.step(Math.min(1, settings.duration), force, now);
    return lesion;
  }

  /** End the current application (lesion keeps the dose delivered so far). Returns it, if any. */
  stop(now: number): Lesion | null {
    const rf = this.rf;
    if (!rf) return null;
    this.rf = null;
    const L = rf.lesion;
    L.active = false;
    L.time = now;
    if (L.energy <= 0) {
      this.lesions = this.lesions.filter((x) => x !== L);
      return null;
    }
    if (this.edema > 0) L.edemaUntil = now + this.edema;
    return L;
  }

  readout(): RfReadout | null {
    return this.rf?.app.readout() ?? null;
  }

  private sync(L: Lesion, r: RfReadout, now: number): void {
    L.duration = r.elapsed;
    L.energy = r.energy;
    L.fti = r.fti;
    L.meanForce = this.rf!.app.meanForce;
    L.impedanceDrop = r.impedanceDrop;
    L.depth = r.depth;
    L.diameter = r.diameter;
    L.lqi = r.lqi;
    if (!Number.isNaN(r.esophagealTemp)) L.esophagealTemp = Number.isNaN(L.esophagealTemp) ? r.esophagealTemp : Math.max(L.esophagealTemp, r.esophagealTemp);
    L.time = now;
  }

  /** Earliest future time (ms) at which an edema resolves, or Infinity. */
  nextEdemaExpiry(now: number): number {
    let t = Infinity;
    for (const L of this.lesions) if (L.edemaUntil > now) t = Math.min(t, L.edemaUntil);
    return t;
  }

  rasterize(now: number): LesionFields {
    return rasterizeLesions(this.lesions, this.mesh.wallThickness, this.fmm, this.mesh.positions, now, this.model);
  }

  /** Shift all stored times when the simulation clock restarts (keeps remaining edema time). */
  rebase(oldNow: number, newNow: number): void {
    for (const L of this.lesions) {
      L.time += newNow - oldNow;
      if (Number.isFinite(L.edemaUntil)) L.edemaUntil += newNow - oldNow;
    }
  }

  reset(): void {
    this.rf = null;
    this.lesions = [];
  }
}

/** Write lesion fields into a substrate (its excitability and edge diffusivities then include them). */
export function applyLesionsToSubstrate(sub: Substrate, f: LesionFields): void {
  sub.lesionCore.set(f.core);
  sub.lesionConductivity.set(f.conductivity);
}
