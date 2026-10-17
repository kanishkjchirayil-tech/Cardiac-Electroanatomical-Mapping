import { hexSheet } from '../core/mesh/primitives';
import { generateAtrium } from '../core/mesh/atrium';
import { buildGeometry, type TissueGeometry } from '../core/ep/fem';
import { createIonicModel, type IonicSpec } from '../core/ep/ionic';
import { CpuBackend } from '../core/ep/solver-cpu';
import { WebGpuBackend } from '../core/ep/solver-gpu';
import { Simulation } from '../core/ep/simulation';
import type { SolverBackend, BackendInit } from '../core/ep/backend';
import { calibrateDiffusivity } from '../core/ep/calibrate';
import { PRESETS, buildTissue, sinusSites } from '../core/ep/tissue';

/**
 * Compares the CPU and WebGPU backends on identical problems and measures throughput.
 * Results are printed and exposed as window.__selftest for automated runs.
 */
const out = document.getElementById('out')!;
const log: string[] = [];
const print = (s: string) => {
  log.push(s);
  out.textContent = log.join('\n');
};

interface Problem {
  init: Omit<BackendInit, 'model'> & { ionic: IonicSpec };
  sites: Array<{ vertices: Uint32Array; delay: number }>;
  duration: number;
}

async function run(kind: 'cpu' | 'webgpu', p: Problem, device?: GPUDevice) {
  const init: BackendInit = { ...p.init, model: createIonicModel(p.init.ionic) };
  const be: SolverBackend = kind === 'cpu' ? new CpuBackend(init) : await WebGpuBackend.create(init, device);
  const sim = new Simulation(be, init.dt);
  p.sites.forEach((s, k) => {
    sim.schedule.addSite({ name: `s${k}`, vertices: s.vertices, amplitude: 0.5, duration: 2 });
    sim.schedule.trains.push({ site: k, start: 1 + s.delay, period: Infinity, count: 1 });
  });
  sim.markSitesChanged();
  const t0 = performance.now();
  await sim.advance(p.duration);
  const wall = performance.now() - t0;
  const act = await be.readActivation();
  const v = await be.readV();
  be.dispose();
  return { act, v, wall, speed: p.duration / wall };
}

function compare(a: Float32Array, b: Float32Array): { maxAbs: number; meanAbs: number; n: number; mismatch: number } {
  let maxAbs = 0, sum = 0, n = 0, mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    const fa = Number.isFinite(a[i]!), fb = Number.isFinite(b[i]!);
    if (fa !== fb) { mismatch++; continue; }
    if (!fa) continue;
    const d = Math.abs(a[i]! - b[i]!);
    maxAbs = Math.max(maxAbs, d);
    sum += d;
    n++;
  }
  return { maxAbs, meanAbs: sum / Math.max(1, n), n, mismatch };
}

function sheetProblem(geom: TissueGeometry, ionic: IonicSpec, D: number): Problem {
  const n = geom.nV;
  const left: number[] = [];
  for (let i = 0; i < n; i++) if (geom.positions[3 * i]! < 1.5) left.push(i);
  return {
    init: { geom, ionic, edgeD: new Float32Array(geom.edgeA.length).fill(D), apdScale: new Float32Array(n).fill(1), excitable: new Uint8Array(n).fill(1), siteOf: new Int32Array(n).fill(-1), dt: createIonicModel(ionic).recommendedDt },
    sites: [{ vertices: Uint32Array.from(left), delay: 0 }],
    duration: 400,
  };
}

async function main() {
  const result: Record<string, unknown> = { userAgent: navigator.userAgent };
  const gpu = navigator.gpu;
  const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
  if (!adapter) {
    print('WebGPU not available: the app will use the CPU worker backend.');
    result.webgpu = false;
    (window as unknown as { __selftest: unknown }).__selftest = result;
    return;
  }
  const device = await adapter.requestDevice();
  result.adapter = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : {};
  print(`Adapter: ${JSON.stringify(result.adapter)}`);

  const sheet = hexSheet(40, 6, 0.955);
  const sg = buildGeometry(sheet.positions, sheet.indices);
  const models: Record<string, unknown> = {};
  for (const id of ['ms', 'ap', 'fk'] as const) {
    const cal = await calibrateDiffusivity({ id }, 0.75, { dt: createIonicModel({ id }).recommendedDt });
    const p = sheetProblem(sg, { id }, cal.D);
    const c = await run('cpu', p);
    const g = await run('webgpu', p, device);
    const lat = compare(c.act.last, g.act.last);
    const rep = compare(c.act.repol, g.act.repol);
    models[id] = { D: cal.D, latMaxAbsMs: lat.maxAbs, repolMaxAbsMs: rep.maxAbs, mismatch: lat.mismatch + rep.mismatch };
    print(`Sheet ${id}: max |ΔLAT| = ${lat.maxAbs.toFixed(4)} ms, max |Δrepol| = ${rep.maxAbs.toFixed(3)} ms, mismatched = ${lat.mismatch + rep.mismatch}`);
  }
  result.sheet = models;

  print('Generating atrium…');
  const { mesh } = generateAtrium();
  const preset = PRESETS.healthy;
  const tissue = buildTissue(mesh, preset, 1);
  const dtLa = createIonicModel(preset.ionic).recommendedDt;
  const cal = await calibrateDiffusivity(preset.ionic, preset.targetCv, { h: tissue.geom.meanEdge, dt: dtLa });
  const n = tissue.geom.nV;
  const la: Problem = {
    init: { geom: tissue.geom, ionic: preset.ionic, edgeD: tissue.substrate.edgeDiffusivity(cal.D), apdScale: tissue.substrate.apdScale, excitable: tissue.substrate.excitable(), siteOf: new Int32Array(n).fill(-1), dt: dtLa },
    sites: sinusSites(mesh),
    duration: 250,
  };
  const c = await run('cpu', la);
  const g = await run('webgpu', la, device);
  const lat = compare(c.act.last, g.act.last);
  result.la = { vertices: n, latMaxAbsMs: lat.maxAbs, latMeanAbsMs: lat.meanAbs, mismatch: lat.mismatch, cpuSpeed: c.speed, gpuSpeed: g.speed };
  print(`LA sinus (${n} vertices): max |ΔLAT| = ${lat.maxAbs.toFixed(4)} ms, mean ${lat.meanAbs.toFixed(5)} ms, mismatched = ${lat.mismatch}`);
  print(`Speed (sim time / wall time): CPU (main thread) ${c.speed.toFixed(3)}×, WebGPU ${g.speed.toFixed(3)}×`);

  // Sustained throughput on the GPU (2 s of simulated time).
  const long = await run('webgpu', { ...la, duration: 2000 }, device);
  result.gpuSustainedSpeed = long.speed;
  print(`WebGPU sustained: ${long.speed.toFixed(3)}× real time over 2 s of simulated time`);
  print('Done.');
  (window as unknown as { __selftest: unknown }).__selftest = result;
}

main().catch((e) => {
  print(`ERROR: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  (window as unknown as { __selftest: unknown }).__selftest = { error: String(e) };
});
