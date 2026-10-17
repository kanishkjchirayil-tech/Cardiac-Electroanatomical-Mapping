import { signal } from '@preact/signals';
import type { SurfaceMesh } from '../core/mesh/types';
import type { MeshQuality } from '../core/mesh/quality';
import type { ClipState, HoverInfo } from '../render/viewer';
import { DEFAULT_SIM_CONFIG, type SimConfig, type SimInfo } from '../engine/protocol';
import type { RestitutionResult } from '../core/ep/calibrate';

export type Overlay = 'shell' | 'regions' | 'thickness';

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
export const gtActivation = signal<{ last: Float32Array; beatStart: number; fibrotic: Uint8Array; t: number } | null>(null);
export const labResult = signal<{ D0: number; cv: number; apd90: number; restitution: RestitutionResult; label: string } | null>(null);
export const labRunning = signal(false);
