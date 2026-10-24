import { getV, type Vec3 } from '../math/vec3';
import type { SurfaceMesh } from '../mesh/types';
import { buildCsCatheter, type CsCatheter } from '../catheter/cs';
import { DEFAULT_ROVING, isStable, rovingPose, TipMotion, type RovingConfig, type RovingPose } from '../catheter/roving';
import { GRID_COUNT, gridPose } from '../catheter/grid';
import { SpatialGrid } from '../mesh/spatial';
import type { EgmSamples } from '../ep/backend';
import { buildLeadField, buildSourceGeometry, DEFAULT_INTRACARDIAC, type LeadField, type SourceGeometry, type SourceOptions } from './leadfield';
import { ECG_ELECTRODES, K_TORSO, TORSO_GAIN } from './ecg';
import { DEFAULT_SIGNALS, RecordingSystem, standardLayout, type ChannelDef, type ElectrodeDef, type SignalSettings } from './recording';

/** Electrogram sampling rate (Hz). */
export const EGM_FS = 2000;
/** Interval at which catheter motion (and its lead fields) is updated, ms of simulated time. */
export const MOTION_UPDATE_MS = 20;

/** Channels recorded for one mapping electrode (indices into the full channel list). */
export interface MappingElectrode {
  name: string;
  /** Index into the roving pose's electrode list. */
  electrode: number;
  uni: number;
  bip: number;
}

/** After a relocation the catheter counts as unstable for this long (ms of simulated time). */
export const SETTLE_MS = 1000;

export interface RovingState {
  vertex: number;
  config: RovingConfig;
  pose: RovingPose;
  /** `settling`: the catheter was relocated within the last SETTLE_MS. */
  stability: ReturnType<TipMotion['stability']> & { stable: boolean; settling: boolean };
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
  readonly vertexIndex: SpatialGrid;
  /** Bumped whenever any lead field changes (backends must re-upload). */
  version = 0;
  motionEnabled = true;
  private lastT = 0;
  private placedAt = -Infinity;

  constructor(readonly mesh: SurfaceMesh, source: SourceOptions, private seed = 1, signals: SignalSettings = DEFAULT_SIGNALS) {
    const layout = standardLayout();
    this.electrodes = layout.electrodes;
    this.channels = layout.channels;
    this.scratch = new Float64Array(mesh.positions.length / 3);
    this.vertexIndex = new SpatialGrid(mesh.positions, 4);
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
    const moved = !this.roving || this.roving.vertex !== vertex || this.roving.config.type !== config.type;
    if (moved) this.placedAt = this.lastT;
    const motion = moved ? new TipMotion(this.seed * 977 + vertex, normal) : this.roving!.motion;
    this.roving = { vertex, config, motion, pose: this.pose(contact, normal, config) };
    this.updateRovingFields();
  }

  setRovingConfig(config: Partial<RovingConfig>): void {
    if (!this.roving) return;
    this.placeRoving(this.roving.vertex, { ...this.roving.config, ...config });
  }

  removeRoving(): void {
    this.roving = null;
    this.clearMappingFields();
    this.version++;
  }

  private clearMappingFields(): void {
    const empty = () => ({ idx: new Uint32Array(0), w: new Float32Array(0) });
    for (let i = 1; i <= 4; i++) this.fields[this.index(`MAP ${i}`)] = empty();
    for (let i = 1; i <= GRID_COUNT; i++) this.fields[this.index(`G${i}`)] = empty();
  }

  /** Mapping electrodes of the active catheter, with their unipolar and bipolar channel indices. */
  mappingElectrodes(): MappingElectrode[] {
    const ch = (n: string) => this.channels.findIndex((c) => c.name === n);
    if (!this.roving) return [];
    if (this.roving.config.type === 'ablation') return [{ name: 'MAP 1', electrode: 0, uni: ch('MAP 1 uni'), bip: ch('MAP 1-2') }];
    return Array.from({ length: GRID_COUNT }, (_, k) => {
      const partner = (k + 1) % 4 === 0 ? k : k + 2;
      return { name: `G${k + 1}`, electrode: k, uni: ch(`G${k + 1} uni`), bip: ch(`G${k + 1}-${partner}`) };
    });
  }

  /** Advance the tip motion model to time t (ms); returns true if lead fields changed. */
  updateMotion(t: number, cycleLength: number): boolean {
    this.lastT = t;
    const r = this.roving;
    if (!r) return false;
    const { displacement, force } = this.motionEnabled ? r.motion.update(t, r.config.force, cycleLength) : { displacement: [0, 0, 0] as Vec3, force: r.config.force };
    r.pose = this.pose(r.pose.contact, r.pose.normal, r.config, force, displacement);
    this.updateRovingFields();
    return true;
  }

  private pose(contact: Vec3, normal: Vec3, config: RovingConfig, force = config.force, displacement: Vec3 = [0, 0, 0]): RovingPose {
    if (config.type === 'ablation') return rovingPose(contact, normal, config, force, displacement);
    const g = gridPose(this.mesh.positions, this.mesh.normals, this.vertexIndex, contact, normal, config.azimuth, force, displacement);
    // The grid lies flat: its "axis" is the inward normal and the tip end is the grid centre.
    const tipEnd: Vec3 = [0, 1, 2].map((k) => g.electrodes.reduce((s, e) => s + e[k]!, 0) / g.electrodes.length) as Vec3;
    return { contact, normal, axis: [-normal[0], -normal[1], -normal[2]], tipEnd, electrodes: g.electrodes, force, gap: g.gap };
  }

  private updateRovingFields(): void {
    const r = this.roving!;
    this.clearMappingFields();
    const grid = r.config.type === 'grid';
    const prefix = grid ? (i: number) => `G${i + 1}` : (i: number) => `MAP ${i + 1}`;
    // Grid electrodes lie in contact, so their near field dominates: a 20 mm cutoff keeps 16 moving
    // lead fields affordable (MODEL.md §4.1).
    const opts = grid ? { ...DEFAULT_INTRACARDIAC, cutoff: 20 } : DEFAULT_INTRACARDIAC;
    r.pose.electrodes.forEach((p, i) => (this.fields[this.index(prefix(i))] = buildLeadField(this.src, p, opts, this.scratch)));
    this.version++;
  }

  rovingState(): RovingState | null {
    const r = this.roving;
    if (!r) return null;
    const st = r.motion.stability();
    const settling = this.lastT - this.placedAt < SETTLE_MS;
    return { vertex: r.vertex, config: r.config, pose: r.pose, stability: { ...st, stable: isStable(st) && !settling, settling } };
  }

  /** Raw electrode samples → displayed channels (n × channels). */
  process(s: EgmSamples): { t0: number; n: number; data: Float32Array } {
    const n = s.times.length;
    if (!n) return { t0: 0, n: 0, data: new Float32Array(0) };
    return { t0: s.times[0]!, n, data: this.recording.process(s.times[0]!, s.data, n) };
  }
}
