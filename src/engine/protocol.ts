import type { SurfaceMesh } from '../core/mesh/types';
import type { PresetId } from '../core/ep/tissue';
import type { IonicModelId } from '../core/ep/ionic';
import type { FibrosisPattern } from '../core/ep/substrate';
import type { RestitutionResult } from '../core/ep/calibrate';
import type { CatheterType, RovingConfig } from '../core/catheter/roving';
import type { ChannelDef, SignalSettings } from '../core/signals/recording';

export type SimMode = 'eikonal' | 'rd';
export type BackendPref = 'auto' | 'cpu';

export interface SimConfig {
  mode: SimMode;
  preset: PresetId;
  /** Ionic model; the preset's parameters apply to Mitchell–Schaeffer only. */
  ionic: IonicModelId;
  seed: number;
  /** Multiplier on the preset's fibrosis density (0 = none). */
  fibrosisScale: number;
  fibrosisPattern: FibrosisPattern;
  /** Sinus cycle length, ms (0 = sinus off). */
  sinusCl: number;
  backend: BackendPref;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  mode: 'eikonal',
  preset: 'healthy',
  ionic: 'ms',
  seed: 1,
  fibrosisScale: 1,
  fibrosisPattern: 'patchy',
  sinusCl: 800,
  backend: 'auto',
};

export interface SimInfo {
  backend: 'cpu' | 'webgpu' | 'eikonal';
  gpuError: string | null;
  nV: number;
  dt: number;
  diffusionSubsteps: number;
  /** Calibrated healthy diffusivity, mm²/ms, and the measured plane-wave CV / APD90. */
  D0: number;
  cv: number;
  apd90: number;
  fibroticFraction: number;
  removedEdgeFraction: number;
  negativeCotEdges: number;
  /** Wall time to build (calibrate + eikonal / backend setup), ms. */
  buildMs: number;
  eikonalMs: number | null;
}

/** Static description of the recording setup, sent with every `ready`. */
export interface RigInfo {
  channels: ChannelDef[];
  fs: number;
  /** CS catheter centreline and electrode centres (flat xyz). */
  csPath: number[];
  csElectrodes: number[];
  /** Transseptal entry point used to draw the roving catheter shaft. */
  transseptal: number[];
}

/** Roving catheter pose and readouts, sent with frames. */
export interface RovingFrame {
  vertex: number;
  config: RovingConfig;
  /** Electrode centres (flat xyz × 4), tip end, axis, contact point and wall normal. */
  electrodes: number[];
  tipEnd: number[];
  axis: number[];
  contact: number[];
  normal: number[];
  force: number;
  gap: number;
  stability: { positionSd: number; forceMean: number; forceMin: number; forceMax: number; stable: boolean; settling: boolean };
}

/**
 * One reference beat as seen by the recording system (MODEL.md §4.2): windows of the reference
 * bipole, ECG II and every mapping electrode's unipolar and bipolar signal, aligned so that the
 * reference activation is at `preMs` into each window, plus the catheter state at that time.
 */
export interface BeatWindow {
  refTime: number;
  /** Reference cycle length (ms) preceding this beat; NaN for the first. */
  cl: number;
  fs: number;
  preMs: number;
  refName: string;
  ref: Float32Array;
  ecg: Float32Array;
  catheter: CatheterType;
  contactVertex: number;
  electrodes: Array<{ name: string; position: number[]; uni: Float32Array; bip: Float32Array }>;
  force: number;
  stability: { positionSd: number; forceMin: number; forceMax: number; stable: boolean; settling?: boolean };
}

/** Processed channel samples: n × nCh row-major, uniform spacing 1/fs starting at t0 (ms). */
export interface EgmChunk {
  t0: number;
  n: number;
  nCh: number;
  data: Float32Array;
}

export type ToWorker =
  | { type: 'init'; mesh: SurfaceMesh; config: SimConfig }
  | { type: 'configure'; config: Partial<SimConfig> }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step'; ms: number }
  | { type: 'reset' }
  | { type: 'setSpeed'; speed: number }
  | { type: 'requestActivation' }
  | { type: 'runLab' }
  | { type: 'placeRoving'; vertex: number }
  | { type: 'rovingConfig'; config: Partial<RovingConfig> }
  | { type: 'signals'; settings: SignalSettings }
  | { type: 'motion'; enabled: boolean }
  | { type: 'setReference'; name: string };

export type FromWorker =
  | { type: 'status'; message: string }
  | { type: 'ready'; info: SimInfo; config: SimConfig; rig: RigInfo }
  | { type: 'frame'; t: number; v: Float32Array; speed: number; running: boolean; egm: EgmChunk | null; roving: RovingFrame | null }
  | { type: 'activation'; t: number; last: Float32Array; beatStart: number; fibrotic: Uint8Array }
  | { type: 'lab'; preset: PresetId; ionic: IonicModelId; D0: number; cv: number; apd90: number; restitution: RestitutionResult }
  | { type: 'beat'; beat: BeatWindow }
  | { type: 'error'; message: string };
