/// <reference lib="webworker" />
import { generateAtrium, type AtriumGenOptions } from '../core/mesh/atrium';
import type { SurfaceMesh } from '../core/mesh/types';
import type { MeshQuality } from '../core/mesh/quality';

export type MeshWorkerRequest = { type: 'generate'; id: number; options: Omit<AtriumGenOptions, 'onProgress'> };
export type MeshWorkerResponse =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | { type: 'result'; id: number; mesh: SurfaceMesh; quality: MeshQuality; timingsMs: Record<string, number> }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<MeshWorkerRequest>) => {
  const req = e.data;
  if (req.type !== 'generate') return;
  try {
    const r = generateAtrium({
      ...req.options,
      onProgress: (stage, fraction) => ctx.postMessage({ type: 'progress', id: req.id, stage, fraction } satisfies MeshWorkerResponse),
    });
    const m = r.mesh;
    ctx.postMessage({ type: 'result', id: req.id, mesh: m, quality: r.quality, timingsMs: r.timingsMs } satisfies MeshWorkerResponse, [
      m.positions.buffer,
      m.indices.buffer,
      m.normals.buffer,
      m.region.buffer,
      m.wallThickness.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) } satisfies MeshWorkerResponse);
  }
};
