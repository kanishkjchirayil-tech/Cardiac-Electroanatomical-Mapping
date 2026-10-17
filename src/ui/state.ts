import { signal } from '@preact/signals';
import type { SurfaceMesh } from '../core/mesh/types';
import type { MeshQuality } from '../core/mesh/quality';
import type { ClipState, HoverInfo } from '../render/viewer';

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
