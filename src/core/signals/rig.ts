import { getV, type Vec3 } from '../math/vec3';
import type { SurfaceMesh } from '../mesh/types';
import { buildCsCatheter, type CsCatheter } from '../catheter/cs';
import { DEFAULT_ROVING, isStable, rovingPose, TipMotion, type RovingConfig, type RovingPose } from '../catheter/roving';
import type { EgmSamples } from '../ep/backend';
import { buildLeadField, buildSourceGeometry, DEFAULT_INTRACARDIAC, type LeadField, type SourceGeometry, type SourceOptions } from './leadfield';
import { ECG_ELECTRODES, K_TORSO, TORSO_GAIN } from './ecg';
import { DEFAULT_SIGNALS, RecordingSystem, standardLayout, type ChannelDef, type ElectrodeDef, type SignalSettings } from './recording';

/** Electrogram sampling rate (Hz). */
export const EGM_FS = 2000;
/** Interval at which catheter motion (and its lead fields) is updated, ms of simulated time. */
export const MOTION_UPDATE_MS = 20;

export interface RovingState {
  vertex: number;
  config: RovingConfig;
  pose: RovingPose;
  stability: ReturnType<TipMotion['stability']> & { stable: boolean };
}

/**
 * The electrode set of a study: body-surface ECG electrodes, the CS decapolar and the roving
 * catheter, with their lead fields and the recording system that turns raw potentials into
 * displayed channels. Framework-free; used by the simulation worker and by tests.
 */
export class ElectrogramRig {
  readonly electrodes: ElectrodeDef[];
  readonly channels: ChannelDef[];
  readonly cs: CsCatheter;
  readonly recording: RecordingSystem;
  private src: SourceGeometry;
  private fields: LeadField[];
  private roving: { vertex: number; config: RovingConfig; motion: TipMotion; pose: RovingPose } | null = null;
  private scratch: Float64Array;
  /** Bumped whenever any lead field changes (backends must re-upload). */
  version = 0;
  motionEnabled = true;

  constructor(readonly mesh: SurfaceMesh, source: SourceOptions, private seed = 1, signals: SignalSettings = DEFAULT_SIGNALS) {
    const layout = standardLayout();
    this.electrodes = layout.electrodes;
    this.channels = layout.channels;
    this.scratch = new Float64Array(mesh.positions.length / 3);
    this.src = buildSourceGeometry(mesh.positions, mesh.indices, source);
    this.cs = buildCsCatheter(mesh);
    this.recording = new RecordingSystem(this.electrodes, this.channels, EGM_FS, signals, seed);
    this.fields = this.electrodes.map(() => ({ idx: new Uint32Array(0), w: new Float32Array(0) }));
    this.buildStaticFields();
  }

  private index(name: string): number {
    return this.electrodes.findIndex((e) => e.name === name);
  }

  private buildStaticFields(): void {
    for (const [name, pos] of Object.entries(ECG_ELECTRODES)) {
      this.fields[this.index(name)] = buildLeadField(this.src, pos, { K: K_TORSO * TORSO_GAIN, cutoff: Infinity }, this.scratch);
    }
    this.cs.electrodes.forEach((p, i) => (this.fields[this.index(`CS ${i + 1}`)] = buildLeadField(this.src, p, DEFAULT_INTRACARDIAC, this.scratch)));
    this.version++;
  }

  /** Rebuild all sources (after substrate changes such as ablation). */
  updateSources(source: SourceOptions): void {
    this.src = buildSourceGeometry(this.mesh.positions, this.mesh.indices, source);
    this.buildStaticFields();
    if (this.roving) this.updateRovingFields();
  }

  /** Lead-field rows in electrode order (ECG, CS 1–10, MAP 1–4). */
  rows(): LeadField[] {
    return this.fields;
  }

  configureSignals(settings: SignalSettings): void {
    this.recording.configure(settings, this.seed);
  }

  placeRoving(vertex: number, config: RovingConfig = this.roving?.config ?? DEFAULT_ROVING): void {
    const contact = getV(this.mesh.positions, vertex), normal = getV(this.mesh.normals, vertex);
    const motion = this.roving && this.roving.vertex === vertex ? this.roving.motion : new TipMotion(this.seed * 977 + vertex, normal);
    this.roving = { vertex, config, motion, pose: rovingPose(contact, normal, config) };
    this.updateRovingFields();
  }

  setRovingConfig(config: Partial<RovingConfig>): void {
    if (!this.roving) return;
    this.placeRoving(this.roving.vertex, { ...this.roving.config, ...config });
  }

  removeRoving(): void {
    this.roving = null;
    for (let i = 1; i <= 4; i++) this.fields[this.index(`MAP ${i}`)] = { idx: new Uint32Array(0), w: new Float32Array(0) };
    this.version++;
  }

  /** Advance the tip motion model to time t (ms); returns true if lead fields changed. */
  updateMotion(t: number, cycleLength: number): boolean {
    const r = this.roving;
    if (!r) return false;
    const { displacement, force } = this.motionEnabled ? r.motion.update(t, r.config.force, cycleLength) : { displacement: [0, 0, 0] as Vec3, force: r.config.force };
    r.pose = rovingPose(r.pose.contact, r.pose.normal, r.config, force, displacement);
    this.updateRovingFields();
    return true;
  }

  private updateRovingFields(): void {
    const r = this.roving!;
    r.pose.electrodes.forEach((p, i) => (this.fields[this.index(`MAP ${i + 1}`)] = buildLeadField(this.src, p, DEFAULT_INTRACARDIAC, this.scratch)));
    this.version++;
  }

  rovingState(): RovingState | null {
    const r = this.roving;
    if (!r) return null;
    const st = r.motion.stability();
    return { vertex: r.vertex, config: r.config, pose: r.pose, stability: { ...st, stable: isStable(st) } };
  }

  /** Raw electrode samples → displayed channels (n × channels). */
  process(s: EgmSamples): { t0: number; n: number; data: Float32Array } {
    const n = s.times.length;
    if (!n) return { t0: 0, n: 0, data: new Float32Array(0) };
    return { t0: s.times[0]!, n, data: this.recording.process(s.times[0]!, s.data, n) };
  }
}
