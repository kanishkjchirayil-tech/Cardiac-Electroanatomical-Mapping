import type { AtriumGenOptions } from '../core/mesh/atrium';
import type { SurfaceMesh } from '../core/mesh/types';
import { meshQuality, type MeshQuality } from '../core/mesh/quality';
import type { MeshWorkerRequest, MeshWorkerResponse } from '../workers/mesh.worker';

/** Bump when the generator's output changes so stale cached meshes are ignored. */
export const GENERATOR_VERSION = 2;

type GenOptions = Omit<AtriumGenOptions, 'onProgress'>;

export interface MeshResult {
  mesh: SurfaceMesh;
  quality: MeshQuality;
  fromCache: boolean;
}

let worker: Worker | null = null;
let nextId = 1;

/** Generate a procedural atrium in a worker, using an IndexedDB cache when available. */
export async function loadProceduralAtrium(options: GenOptions, onProgress: (stage: string, f: number) => void): Promise<MeshResult> {
  const key = `atrium:v${GENERATOR_VERSION}:${JSON.stringify(options)}`;
  const cached = await cacheGet<SurfaceMesh>(key);
  if (cached) return { mesh: cached, quality: meshQuality(cached.positions, cached.indices), fromCache: true };

  worker ??= new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' });
  const id = nextId++;
  const w = worker;
  const result = await new Promise<MeshResult>((resolve, reject) => {
    const handler = (e: MessageEvent<MeshWorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') onProgress(msg.stage, msg.fraction);
      else {
        w.removeEventListener('message', handler);
        if (msg.type === 'result') resolve({ mesh: msg.mesh, quality: msg.quality, fromCache: false });
        else reject(new Error(msg.message));
      }
    };
    w.addEventListener('message', handler);
    w.postMessage({ type: 'generate', id, options } satisfies MeshWorkerRequest);
  });
  await cacheSet(key, result.mesh);
  return result;
}

// ---- Minimal IndexedDB key/value cache. Every call tolerates IndexedDB being unavailable. ----

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('ostium-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
