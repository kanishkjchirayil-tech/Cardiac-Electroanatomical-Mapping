import { signal } from '@preact/signals';
import { MappingSession, type FilterResult } from '../core/mapping/session';
import { MapInterpolator } from '../core/mapping/interpolate';
import { SpatialGrid } from '../core/mesh/spatial';
import type { SurfaceMesh } from '../core/mesh/types';
import type { BeatWindow } from '../engine/protocol';
import { overlay } from './state';

/**
 * Main-thread mapping system state. Points, annotations and maps are derived only from beat
 * windows sent by the recording system (never from the simulated tissue).
 */
export type MapType = 'lat' | 'bipolar' | 'unipolar' | 'fractionation' | 'propagation';

export interface MapDisplay {
  type: MapType;
  /** Manual colour range for LAT (null = automatic from the points). */
  latRange: [number, number] | null;
  /** Bipolar voltage thresholds (scar, normal), mV. */
  bipolarThresholds: [number, number];
  unipolarThresholds: [number, number];
  showPoints: boolean;
  cvVectors: boolean;
}

export const DEFAULT_MAP_DISPLAY: MapDisplay = {
  type: 'lat',
  latRange: null,
  bipolarThresholds: [0.1, 0.5],
  unipolarThresholds: [0.5, 2.5],
  showPoints: true,
  cvVectors: false,
};

export let session: MappingSession | null = null;
export let interpolator: MapInterpolator | null = null;
export let vertexGrid: SpatialGrid | null = null;

/** Bumped on any change to points or mapping settings. */
export const mapVersion = signal(0);
export const selectedPoint = signal<number | null>(null);
export const autoAcquire = signal(false);
export const mapDisplay = signal<MapDisplay>({ ...DEFAULT_MAP_DISPLAY });
export const latestBeat = signal<{ beat: BeatWindow; check: FilterResult } | null>(null);
/** Anatomy-build mode: only shell regions swept by the catheter are shown. */
export const anatomyBuild = signal(false);
export const revealedVersion = signal(0);
export let revealed: Uint8Array | null = null;

export function initMapping(mesh: SurfaceMesh): void {
  vertexGrid = new SpatialGrid(mesh.positions, 4);
  session = new MappingSession(vertexGrid);
  interpolator = new MapInterpolator(mesh.positions, mesh.normals, mesh.indices);
  revealed = new Uint8Array(mesh.region.length);
  selectedPoint.value = null;
  latestBeat.value = null;
  mapVersion.value++;
  revealedVersion.value++;
}

export function bump(): void {
  mapVersion.value++;
}

/** Show the map overlay once the first points exist. */
function showMapIfFirst(added: number): void {
  if (added && session && session.points.length === added) overlay.value = 'map';
}

/** Handle a beat from the recording system: track CL, show the filter verdict, auto-acquire. */
export function onBeat(beat: BeatWindow): void {
  if (!session) return;
  session.observe(beat);
  const centre = beat.electrodes[Math.floor(beat.electrodes.length / 2)]!;
  latestBeat.value = { beat, check: session.check(beat, centre.position) };
  if (autoAcquire.peek()) {
    const n = session.acquire(beat, 'auto').length;
    if (n) {
      showMapIfFirst(n);
      bump();
    }
  }
}

/** Manual acquisition from the most recent beat. */
export function acquireNow(): number {
  const b = latestBeat.peek()?.beat;
  if (!session || !b) return 0;
  const added = session.acquire(b, 'manual');
  if (added.length) {
    selectedPoint.value = added[0]!.id;
    showMapIfFirst(added.length);
    bump();
  }
  return added.length;
}

/** Reveal the shell around catheter electrodes (anatomy-build mode). */
export function reveal(points: number[], radius = 7): void {
  if (!revealed || !vertexGrid) return;
  let changed = false;
  const tmp: number[] = [];
  for (let i = 0; i < points.length; i += 3) {
    for (const v of vertexGrid.within([points[i]!, points[i + 1]!, points[i + 2]!], radius, tmp)) {
      if (!revealed[v]) { revealed[v] = 1; changed = true; }
    }
  }
  if (changed) revealedVersion.value++;
}

export function resetReveal(): void {
  revealed?.fill(0);
  revealedVersion.value++;
}
