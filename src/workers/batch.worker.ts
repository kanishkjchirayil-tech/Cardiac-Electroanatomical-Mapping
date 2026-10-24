/// <reference lib="webworker" />
import { runBatch, type BatchSpec } from '../engine/batch';
import type { SurfaceMesh } from '../core/mesh/types';

/** Headless batch generation (MODEL.md §7.3), off the main thread. */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let cancel = false;

ctx.onmessage = async (e: MessageEvent<{ type: 'run'; spec: BatchSpec; mesh: SurfaceMesh } | { type: 'cancel' }>) => {
  const m = e.data;
  if (m.type === 'cancel') { cancel = true; return; }
  cancel = false;
  try {
    const dataset = await runBatch(m.spec, m.mesh, (p) => ctx.postMessage({ type: 'progress', progress: p }), () => cancel);
    ctx.postMessage({ type: 'done', dataset, cancelled: cancel });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
