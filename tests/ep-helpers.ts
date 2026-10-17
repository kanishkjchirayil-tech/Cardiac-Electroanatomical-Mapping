import { buildGeometry, type TissueGeometry } from '../src/core/ep/fem';
import { createIonicModel, type IonicSpec } from '../src/core/ep/ionic';
import { CpuBackend } from '../src/core/ep/solver-cpu';
import { Simulation } from '../src/core/ep/simulation';
import type { SimpleMesh } from '../src/core/mesh/primitives';

/** Uniform tissue on a mesh with a CPU backend and a stimulus at the given vertex sets. */
export function uniformSim(mesh: SimpleMesh | TissueGeometry, ionic: IonicSpec, D: number, sites: Uint32Array[] = []) {
  const geom = 'mass' in mesh ? mesh : buildGeometry(mesh.positions, mesh.indices);
  const model = createIonicModel(ionic);
  const n = geom.nV;
  const be = new CpuBackend({
    geom,
    model,
    edgeD: new Float32Array(geom.edgeA.length).fill(D),
    apdScale: new Float32Array(n).fill(1),
    excitable: new Uint8Array(n).fill(1),
    siteOf: new Int32Array(n).fill(-1),
    dt: model.recommendedDt,
  });
  const sim = new Simulation(be, model.recommendedDt);
  sites.forEach((v, k) => sim.schedule.addSite({ name: `s${k}`, vertices: v, amplitude: 0.5, duration: 2 }));
  sim.markSitesChanged();
  return { geom, be, sim, model };
}

export function select(geom: { positions: Float32Array; nV: number }, pred: (x: number, y: number, z: number) => boolean): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i < geom.nV; i++) if (pred(geom.positions[3 * i]!, geom.positions[3 * i + 1]!, geom.positions[3 * i + 2]!)) out.push(i);
  return Uint32Array.from(out);
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}
