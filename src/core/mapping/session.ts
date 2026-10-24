import type { Vec3 } from '../math/vec3';
import type { SpatialGrid } from '../mesh/spatial';
import { annotate } from './annotate';
import { DEFAULT_MAPPING, type Annotation, type EgmWindowData, type MappingSettings, type MapPoint } from './types';

/** A recorded reference beat, as delivered by the recording system (subset of the worker's BeatWindow). */
export interface RecordedBeat {
  refTime: number;
  cl: number;
  fs: number;
  preMs: number;
  ref: Float32Array;
  catheter: 'ablation' | 'grid';
  electrodes: Array<{ name: string; position: number[]; uni: Float32Array; bip: Float32Array }>;
  force: number;
  stability: { positionSd: number; forceMin: number; forceMax: number; stable: boolean; settling?: boolean };
}

export interface FilterResult {
  ok: boolean;
  reasons: string[];
}

type UndoAction =
  | { kind: 'add'; ids: number[] }
  | { kind: 'delete'; points: MapPoint[] }
  | { kind: 'annotate'; id: number; before: Annotation }
  | { kind: 'tag'; id: number; before: string[] }
  | { kind: 'exclude'; id: number; before: boolean };

/**
 * Mapping session (framework-free): point acquisition with stability filters, annotation,
 * manual re-annotation, tags, exclusion and undo. Map interpolation lives in MapInterpolator.
 */
export class MappingSession {
  points: MapPoint[] = [];
  settings: MappingSettings = structuredClone(DEFAULT_MAPPING);
  private nextId = 1;
  private undoStack: UndoAction[] = [];
  private recentCl: number[] = [];
  /** Bumped on every change to points or annotations. */
  version = 0;

  constructor(private readonly vertices: SpatialGrid) {}

  /** Median of the last few reference cycle lengths. */
  referenceCl(): number {
    const v = this.recentCl.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1]! : NaN;
  }

  /** Register a beat for cycle-length tracking (call for every beat, acquired or not). */
  observe(beat: RecordedBeat): void {
    if (Number.isFinite(beat.cl)) {
      this.recentCl.push(beat.cl);
      if (this.recentCl.length > 8) this.recentCl.shift();
    }
  }

  /** Auto-acquisition criteria for one electrode of a beat. */
  check(beat: RecordedBeat, position: number[]): FilterResult {
    const f = this.settings.filters;
    const reasons: string[] = [];
    if (beat.stability.settling) reasons.push('catheter moved during this beat');
    if (beat.stability.positionSd > f.maxPositionSd) reasons.push(`tip moving (SD ${beat.stability.positionSd.toFixed(1)} mm)`);
    if (beat.stability.forceMin < f.forceMin) reasons.push(`force < ${f.forceMin} g`);
    if (beat.stability.forceMax > f.forceMax) reasons.push(`force > ${f.forceMax} g`);
    const ref = this.referenceCl();
    if (Number.isFinite(ref) && Number.isFinite(beat.cl) && Math.abs(beat.cl / ref - 1) * 100 > f.clTolerance) reasons.push(`CL ${beat.cl.toFixed(0)} ms ≠ reference ${ref.toFixed(0)} ms`);
    const proj = this.vertices.nearest(position);
    if (proj.distance > this.settings.projectionCutoff) reasons.push(`off surface (${proj.distance.toFixed(1)} mm)`);
    if (this.points.some((p) => Math.hypot(p.location[0] - position[0]!, p.location[1] - position[1]!, p.location[2] - position[2]!) < f.minSpacing)) reasons.push('too close to an existing point');
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Acquire points from a beat. Manual acquisition takes every electrode regardless of filters;
   * auto acquisition takes only electrodes that pass them. Returns the new points.
   */
  acquire(beat: RecordedBeat, mode: 'manual' | 'auto'): MapPoint[] {
    const added: MapPoint[] = [];
    for (const e of beat.electrodes) {
      if (mode === 'auto' && !this.check(beat, e.position).ok) continue;
      const window: EgmWindowData = { fs: beat.fs, preMs: beat.preMs, ref: beat.ref, uni: e.uni, bip: e.bip };
      const ann = annotate(window, this.settings.woi, this.settings.latMethod);
      const proj = this.vertices.nearest(e.position);
      const p: MapPoint = {
        id: this.nextId++,
        time: beat.refTime,
        location: [e.position[0]!, e.position[1]!, e.position[2]!] as Vec3,
        vertex: proj.index,
        projectionDistance: proj.distance,
        catheter: beat.catheter,
        electrode: e.name,
        force: beat.force,
        stable: beat.stability.stable,
        positionSd: beat.stability.positionSd,
        cl: beat.cl,
        window,
        auto: ann,
        ann,
        tags: [],
        excluded: false,
      };
      this.points.push(p);
      added.push(p);
    }
    if (added.length) {
      this.undoStack.push({ kind: 'add', ids: added.map((p) => p.id) });
      this.version++;
    }
    return added;
  }

  get(id: number): MapPoint | undefined {
    return this.points.find((p) => p.id === id);
  }

  remove(ids: number[]): void {
    const set = new Set(ids);
    const removed = this.points.filter((p) => set.has(p.id));
    if (!removed.length) return;
    this.points = this.points.filter((p) => !set.has(p.id));
    this.undoStack.push({ kind: 'delete', points: removed });
    this.version++;
  }

  /** Manual re-annotation: set LAT (ms relative to the reference). */
  setLat(id: number, lat: number): void {
    const p = this.get(id);
    if (!p) return;
    this.undoStack.push({ kind: 'annotate', id, before: p.ann });
    p.ann = { ...p.ann, lat, method: 'manual' };
    this.version++;
  }

  /** Revert a point to its automatic annotation. */
  resetAnnotation(id: number): void {
    const p = this.get(id);
    if (!p || p.ann === p.auto) return;
    this.undoStack.push({ kind: 'annotate', id, before: p.ann });
    p.ann = p.auto;
    this.version++;
  }

  toggleTag(id: number, tag: string): void {
    const p = this.get(id);
    if (!p) return;
    this.undoStack.push({ kind: 'tag', id, before: [...p.tags] });
    p.tags = p.tags.includes(tag) ? p.tags.filter((t) => t !== tag) : [...p.tags, tag];
    this.version++;
  }

  setExcluded(id: number, excluded: boolean): void {
    const p = this.get(id);
    if (!p || p.excluded === excluded) return;
    this.undoStack.push({ kind: 'exclude', id, before: p.excluded });
    p.excluded = excluded;
    this.version++;
  }

  /** Change the WOI or LAT method and re-annotate every automatically annotated point. */
  reannotateAll(settings: Partial<MappingSettings>): void {
    this.settings = { ...this.settings, ...settings };
    for (const p of this.points) {
      const auto = annotate(p.window, this.settings.woi, this.settings.latMethod);
      const manual = p.ann.method === 'manual';
      p.auto = auto;
      p.ann = manual ? { ...auto, lat: p.ann.lat, method: 'manual' } : auto;
    }
    this.version++;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo(): void {
    const a = this.undoStack.pop();
    if (!a) return;
    switch (a.kind) {
      case 'add': {
        const s = new Set(a.ids);
        this.points = this.points.filter((p) => !s.has(p.id));
        break;
      }
      case 'delete':
        this.points = [...this.points, ...a.points].sort((x, y) => x.id - y.id);
        break;
      case 'annotate': { const p = this.get(a.id); if (p) p.ann = a.before; break; }
      case 'tag': { const p = this.get(a.id); if (p) p.tags = a.before; break; }
      case 'exclude': { const p = this.get(a.id); if (p) p.excluded = a.before; break; }
    }
    this.version++;
  }

  clear(): void {
    if (!this.points.length) return;
    this.undoStack.push({ kind: 'delete', points: this.points });
    this.points = [];
    this.version++;
  }

  /** Points usable for maps: not excluded and within the projection cutoff. */
  mapPoints(): MapPoint[] {
    return this.points.filter((p) => !p.excluded && p.projectionDistance <= this.settings.projectionCutoff);
  }
}
