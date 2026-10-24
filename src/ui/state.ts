import { signal } from '@preact/signals';
import type { SurfaceMesh } from '../core/mesh/types';
import type { MeshQuality } from '../core/mesh/quality';
import type { ClipState, HoverInfo } from '../render/viewer';
import { DEFAULT_SIM_CONFIG, type RfFrame, type RigInfo, type RovingFrame, type SimConfig, type SimInfo } from '../engine/protocol';
import { DEFAULT_ABLATION, type AblationSettings } from '../core/ablation/controller';
import type { Lesion } from '../core/ablation/lesion';
import { DEFAULT_ROVING, type RovingConfig } from '../core/catheter/roving';
import { DEFAULT_SIGNALS, type SignalSettings } from '../core/signals/recording';
import type { RestitutionResult } from '../core/ep/calibrate';

export type Overlay = 'shell' | 'regions' | 'thickness' | 'map';

export const mesh = signal<SurfaceMesh | null>(null);
export const quality = signal<MeshQuality | null>(null);
export const meshSource = signal<string>('');
export const loading = signal<{ stage: string; fraction: number } | null>(null);
export const errorMsg = signal<string | null>(null);
export const importWarnings = signal<string[]>([]);

export const overlay = signal<Overlay>('regions');
export const highlightRegion = signal<number | null>(null);
export const wireframe = signal(false);
export const showLabels = signal(true);
export const opacity = signal(1);
export const obliqueDeg = signal(30);
export const clip = signal<ClipState>({ enabled: false, axis: 'view', offset: 0, flip: false });

export const hover = signal<HoverInfo | null>(null);
export const fps = signal(0);

export const genSeed = signal(1);
export const genVariability = signal(0);

// ---- Simulation ----
export type TeacherOverlay = 'vm' | 'lat' | 'substrate';

export const simConfig = signal<SimConfig>({ ...DEFAULT_SIM_CONFIG });
export const simInfo = signal<SimInfo | null>(null);
export const simStatus = signal<string>('');
export const simTime = signal(0);
export const simSpeed = signal(0);
export const simRunning = signal(false);
/** Target speed (sim ms per wall ms); 0 = maximum. */
export const speedTarget = signal(1);
/** Ground truth is only shown when the teacher view is enabled (off by default). */
export const teacherView = signal(false);
export const teacherOverlay = signal<TeacherOverlay>('vm');
/** Bumped whenever a new Vm frame arrives (the array itself is kept outside the signal graph). */
export const vmFrameId = signal(0);
export const gtActivation = signal<{ last: Float32Array; beatStart: number; fibrotic: Uint8Array; lesion: Uint8Array; t: number } | null>(null);
export const labResult = signal<{ D0: number; cv: number; apd90: number; restitution: RestitutionResult; label: string } | null>(null);
export const labRunning = signal(false);

// ---- Catheters and signals ----
export const rigInfo = signal<RigInfo | null>(null);
export const roving = signal<RovingFrame | null>(null);
export const rovingConfig = signal<RovingConfig>({ ...DEFAULT_ROVING });
export const signalSettings = signal<SignalSettings>(DEFAULT_SIGNALS);
export const motionEnabled = signal(true);
/** Bumped when new EGM samples arrive. */
export const egmVersion = signal(0);
/** CS bipole used as the timing reference (EGM panel, beat detection and mapping). */
export const referenceChannel = signal('CS 7-8');

// ---- Ablation ----
export const ablationSettings = signal<AblationSettings>({ ...DEFAULT_ABLATION });
export const lesions = signal<Lesion[]>([]);
/** Ground-truth lesion raster (teacher substrate overlay) and the esophageal warning zone. */
export const lesionKind = signal<Uint8Array | null>(null);
export const esophagealZone = signal<Uint8Array | null>(null);
export const rf = signal<RfFrame | null>(null);
export const showLesionTags = signal(true);
export const showEsophagus = signal(true);
/** Deliver each application at once instead of on the (accelerated) RF clock. */
export const rfInstant = signal(false);
