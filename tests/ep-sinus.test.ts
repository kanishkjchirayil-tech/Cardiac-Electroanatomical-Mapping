import { describe, expect, it } from 'vitest';
import { calibrateDiffusivity } from '../src/core/ep/calibrate';
import { createIonicModel } from '../src/core/ep/ionic';
import { CpuBackend } from '../src/core/ep/solver-cpu';
import { Simulation } from '../src/core/ep/simulation';
import { PRESETS, buildTissue, sinusSites, type PresetId } from '../src/core/ep/tissue';
import { fastMarching } from '../src/core/ep/eikonal';
import { triangleConductionVelocity, median } from '../src/core/ep/cv';
import { Region } from '../src/core/mesh/regions';
import { defaultAtrium } from './helpers';
import { pearson } from './ep-helpers';

async function sinusBeat(preset: PresetId) {
  const { mesh } = defaultAtrium();
  const p = PRESETS[preset];
  const tissue = buildTissue(mesh, p, 1);
  const model = createIonicModel(p.ionic);
  const cal = await calibrateDiffusivity(p.ionic, p.targetCv, { h: tissue.geom.meanEdge, dt: model.recommendedDt });
  const n = tissue.geom.nV;
  const be = new CpuBackend({
    geom: tissue.geom, model, edgeD: tissue.substrate.edgeDiffusivity(cal.D), apdScale: tissue.substrate.apdScale,
    excitable: tissue.substrate.excitable(), siteOf: new Int32Array(n).fill(-1), dt: model.recommendedDt,
  });
  const sim = new Simulation(be, model.recommendedDt);
  const sites = sinusSites(mesh);
  sites.forEach((s, k) => {
    sim.schedule.addSite({ name: s.name, vertices: s.vertices, amplitude: 0.5, duration: 2 });
    sim.schedule.trains.push({ site: k, start: 1 + s.delay, period: Infinity, count: 1 });
  });
  sim.markSitesChanged();
  await sim.advance(300);
  return { mesh, tissue, act: be.readActivation(), sites, preset: p };
}

describe('sinus rhythm on the left atrium', () => {
  it('healthy: whole LA activates once, total activation time 80–140 ms, earliest at Bachmann bundle', async () => {
    const { mesh, act, sites } = await sinusBeat('healthy');
    let lo = Infinity, hi = -Infinity, first = -1;
    for (let i = 0; i < act.last.length; i++) {
      expect(act.count[i]).toBe(1);
      if (act.last[i]! < lo) { lo = act.last[i]!; first = i; }
      hi = Math.max(hi, act.last[i]!);
    }
    expect(hi - lo).toBeGreaterThan(80);
    expect(hi - lo).toBeLessThan(140);
    expect(sites[0]!.vertices).toContain(first);
    expect([Region.Septum, Region.Roof, Region.Anterior]).toContain(mesh.region[first]!);
    // Latest activation in the lateral / LAA / left-vein territory, far from the septum.
    let last = 0;
    for (let i = 0; i < act.last.length; i++) if (act.last[i]! > act.last[last]!) last = i;
    expect(mesh.positions[3 * last]!).toBeGreaterThan(0);
  });

  it('measured local CV on the atrium matches the calibrated target (median within 15 %)', async () => {
    const { mesh, act, sites, preset } = await sinusBeat('healthy');
    const near = new Uint8Array(act.last.length);
    for (const s of sites) for (const v of s.vertices) near[v] = 1;
    const cv = triangleConductionVelocity(mesh.positions, mesh.indices, act.last);
    // Exclude triangles close to sources (wavefront curvature, collisions are short-lived).
    const vals: number[] = [];
    for (let f = 0; f < cv.speed.length; f++) {
      const a = mesh.indices[3 * f]!;
      if (!near[a] && act.last[a]! > 25 && cv.speed[f]! < 3) vals.push(cv.speed[f]!);
    }
    expect(Math.abs(median(vals) / preset.targetCv - 1)).toBeLessThan(0.15);
  });

  it('eikonal map agrees with reaction–diffusion (r > 0.99) and takes < 1 s', async () => {
    const { mesh, tissue, act, sites, preset } = await sinusBeat('healthy');
    const exc = tissue.substrate.excitable();
    const speed = Float32Array.from(exc, (e) => (e ? preset.targetCv : 0));
    const t0 = performance.now();
    const T = fastMarching(mesh.positions, mesh.indices, speed, sites.flatMap((s) => Array.from(s.vertices, (v) => ({ vertex: v, t0: s.delay }))));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < T.length; i++) if (Number.isFinite(T[i]!) && Number.isFinite(act.last[i]!)) { xs.push(act.last[i]!); ys.push(T[i]!); }
    expect(pearson(xs, ys)).toBeGreaterThan(0.99);
  });

  it('persistent AF substrate: fibrosis slows and fragments activation (longer total activation)', async () => {
    const h = await sinusBeat('healthy');
    const q = await sinusBeat('persistent');
    const span = (a: Float32Array) => {
      let lo = Infinity, hi = -Infinity;
      for (const x of a) if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      return hi - lo;
    };
    expect(span(q.act.last)).toBeGreaterThan(1.3 * span(h.act.last));
    const exc = q.tissue.substrate.excitable();
    let reached = 0, total = 0;
    exc.forEach((e, i) => { if (e) { total++; if (Number.isFinite(q.act.last[i]!)) reached++; } });
    expect(reached / total).toBeGreaterThan(0.98);
  });
});
