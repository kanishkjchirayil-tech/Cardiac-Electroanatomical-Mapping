import type { Vec3 } from '../math/vec3';

/**
 * Mapping-system data types (MODEL.md §4). The mapping module sees only what a recording system
 * provides — electrogram windows aligned to a reference and catheter positions — never the
 * simulated tissue state.
 */
export interface EgmWindowData {
  fs: number;
  /** Milliseconds before the nominal reference activation in each array. */
  preMs: number;
  ref: Float32Array;
  uni: Float32Array;
  bip: Float32Array;
}

/** Window of interest relative to the reference activation, ms. */
export interface Woi {
  start: number;
  end: number;
}

export type LatMethod = 'unipolar' | 'bipolar';

export interface Annotation {
  /** Local activation time relative to the reference, ms (NaN when none found). */
  lat: number;
  method: LatMethod | 'manual';
  /** Peak-to-peak voltage within the WOI, mV. */
  bipolarVoltage: number;
  unipolarVoltage: number;
  /** Number of alternating deflections of the bipolar signal within the WOI. */
  deflections: number;
  /** Duration of bipolar activity (|bip| above threshold) within the WOI, ms. */
  duration: number;
  fractionated: boolean;
  doublePotential: boolean;
  /** Refinement of the reference timing (ms) relative to the window's nominal reference. */
  refOffset: number;
}

export interface MapPoint {
  id: number;
  /** Simulated time of the reference beat, ms. */
  time: number;
  /** Catheter electrode location at acquisition (mm, LPS). */
  location: Vec3;
  /** Nearest shell vertex and distance to it (projection). */
  vertex: number;
  projectionDistance: number;
  catheter: 'ablation' | 'grid';
  electrode: string;
  force: number;
  stable: boolean;
  positionSd: number;
  cl: number;
  window: EgmWindowData;
  /** Automatic annotation (kept for undoing manual edits). */
  auto: Annotation;
  /** Current annotation (auto or manual). */
  ann: Annotation;
  tags: string[];
  /** User exclusion from maps. */
  excluded: boolean;
}

export interface AcquisitionFilters {
  /** Maximum tip-position SD over the last second, mm. */
  maxPositionSd: number;
  forceMin: number;
  forceMax: number;
  /** Allowed cycle-length deviation from the reference cycle length, %. */
  clTolerance: number;
  /** Minimum distance between points (auto-acquire), mm. */
  minSpacing: number;
}

export interface MappingSettings {
  woi: Woi;
  latMethod: LatMethod;
  filters: AcquisitionFilters;
  /** Points farther than this from the shell are excluded from maps, mm. */
  projectionCutoff: number;
  /** Vertices farther (geodesically) than this from every point stay unmapped, mm. */
  fillThreshold: number;
}

export const DEFAULT_MAPPING: MappingSettings = {
  woi: { start: -100, end: 150 },
  latMethod: 'unipolar',
  filters: { maxPositionSd: 1.0, forceMin: 5, forceMax: 40, clTolerance: 10, minSpacing: 2 },
  projectionCutoff: 6,
  fillThreshold: 12,
};
