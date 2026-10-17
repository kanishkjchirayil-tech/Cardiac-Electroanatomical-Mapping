import type { SurfaceMesh } from '../core/mesh/types';
import type { PresetId } from '../core/ep/tissue';
import type { IonicModelId } from '../core/ep/ionic';
import type { FibrosisPattern } from '../core/ep/substrate';
import type { RestitutionResult } from '../core/ep/calibrate';

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

export type ToWorker =
  | { type: 'init'; mesh: SurfaceMesh; config: SimConfig }
  | { type: 'configure'; config: Partial<SimConfig> }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step'; ms: number }
  | { type: 'reset' }
  | { type: 'setSpeed'; speed: number }
  | { type: 'requestActivation' }
  | { type: 'runLab' };

export type FromWorker =
  | { type: 'status'; message: string }
  | { type: 'ready'; info: SimInfo; config: SimConfig }
  | { type: 'frame'; t: number; v: Float32Array; speed: number; running: boolean }
  | { type: 'activation'; t: number; last: Float32Array; beatStart: number; fibrotic: Uint8Array }
  | { type: 'lab'; preset: PresetId; ionic: IonicModelId; D0: number; cv: number; apd90: number; restitution: RestitutionResult }
  | { type: 'error'; message: string };
