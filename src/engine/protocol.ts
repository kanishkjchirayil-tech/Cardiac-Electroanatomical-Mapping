import type { SurfaceMesh } from '../core/mesh/types';
import type { PresetId } from '../core/ep/tissue';
import type { IonicModelId } from '../core/ep/ionic';
import type { FibrosisPattern } from '../core/ep/substrate';
import type { RestitutionResult } from '../core/ep/calibrate';
import type { CatheterType, RovingConfig } from '../core/catheter/roving';
import type { ChannelDef, SignalSettings } from '../core/signals/recording';
import type { AblationSettings } from '../core/ablation/controller';
import type { Lesion } from '../core/ablation/lesion';
import type { RfReadout } from '../core/ablation/rf';
import type { PacingProtocol, PacingRequest, PacingSite } from '../core/pacing/protocols';
import type { ScenarioId, ScenarioPublic, ScenarioTruth } from '../core/scenarios/scenarios';
import type { PvName } from '../core/mesh/regions';

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
  /** Clinical scenario (seeded ground truth); null = free simulation with the settings above. */
  scenario: { id: ScenarioId; seed: number; /** Changes on every (re)start so the same case can be restarted. */ run?: number } | null;
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
  scenario: null,
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
  /** Esophagus centreline (flat xyz) and radius, mm, for display. */
  esophagus: { path: number[]; radius: number };
}

/** Live RF application state, sent with frames while RF is on. */
export interface RfFrame extends RfReadout {
  lesionId: number;
  inEsophagealZone: boolean;
}

/** One electrogram channel's stimulus-to-local-activation interval during pacing. */
export interface PacingInterval {
  channel: string;
  /** Median over the recent paced beats, ms; null if no local activation was seen. */
  ms: number | null;
  /** Distance from the pacing cathode to the bipole centre, mm. */
  distance: number;
}

/** Pacing state and signal-derived measurements (recorded electrograms only). */
export interface PacingStatus {
  active: boolean;
  site: PacingSite;
  output: number;
  protocol: PacingProtocol;
  t0: number;
  stims: number;
  /** Local capture seen on the neighbouring bipole after recent stimuli. */
  localCapture: boolean | null;
  /** Roving pacing: every recent stimulus was followed by CS activation (1:1 conduction). */
  csFollows: boolean | null;
  intervals: PacingInterval[];
  entrain: { tcl: number; ppi: number; diff: number } | null;
  rovingVertex: number;
  rovingRegion: number;
}

/** A finished pacing manoeuvre, kept for the case report. */
export interface PacingLogEntry extends PacingStatus {
  end: number;
  /** Ground truth: fraction of stimuli that captured tissue (report and teacher only). */
  captureTruth: number;
}

/** Hidden-state evaluation for the end-of-case report (MODEL.md §6.3). */
export interface CaseGroundTruth {
  scenario: ScenarioPublic | null;
  truth: ScenarioTruth | null;
  seed: number;
  simTime: number;
  wallMs: number;
  pv: Array<{ pv: PvName; isolated: boolean; durable: boolean; connected: number }>;
  mitralBlock: { now: boolean; durable: boolean };
  roofBlock: { now: boolean; durable: boolean };
  sources: Array<{ name: string; eliminated: boolean; isolated: boolean }>;
  gapClosed: boolean | null;
  rhythm: 'sinus' | 'not-sinus';
  inductions: number;
  cardioversions: number;
  pacingLog: PacingLogEntry[];
  lesions: { user: number; prior: number; rfSeconds: number; meanLqi: number; belowTarget: number };
  safety: { esophagealWarnings: number; maxEsophagealTemp: number; highForceLesions: number; lesionsInEsophagealZone: number };
  /** Position of the true earliest site (sinus breakthrough or focus), for map checks. */
  earliest: number[] | null;
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
  | { type: 'setReference'; name: string }
  | { type: 'ablationSettings'; settings: AblationSettings }
  | { type: 'rfStart'; instant: boolean }
  | { type: 'rfStop' }
  | { type: 'resetLesions' }
  | { type: 'pace'; request: PacingRequest }
  | { type: 'paceStop' }
  | { type: 'cardiovert' }
  | { type: 'requestReport' };

export type FromWorker =
  | { type: 'status'; message: string }
  | { type: 'ready'; info: SimInfo; config: SimConfig; rig: RigInfo; scenario: ScenarioPublic | null }
  | { type: 'frame'; t: number; v: Float32Array; speed: number; running: boolean; egm: EgmChunk | null; roving: RovingFrame | null; rf: RfFrame | null; stims: number[] }
  | { type: 'activation'; t: number; last: Float32Array; beatStart: number; fibrotic: Uint8Array; lesion: Uint8Array }
  | { type: 'lab'; preset: PresetId; ionic: IonicModelId; D0: number; cv: number; apd90: number; restitution: RestitutionResult }
  | { type: 'beat'; beat: BeatWindow }
  /** The full lesion list (after any change); `kind` is the ground-truth lesion raster (teacher view). */
  | { type: 'lesions'; lesions: Lesion[]; kind: Uint8Array; esophagealZone: Uint8Array }
  | { type: 'pacing'; status: PacingStatus | null }
  | { type: 'report'; report: CaseGroundTruth }
  /** The engine changed the timing reference (automatic choice at case start). */
  | { type: 'reference'; name: string }
  | { type: 'error'; message: string };
