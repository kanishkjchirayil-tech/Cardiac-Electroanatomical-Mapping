import { describe, expect, it } from 'vitest';
import { AUTONOMIC, autonomicApdScale, buildGpZones, gpDensity, gpEfficacy, sinusClFactor } from '../src/core/ep/autonomic';
import { PRESETS, buildTissue, sinusSites } from '../src/core/ep/tissue';
import { createIonicModel } from '../src/core/ep/ionic';
import { calibrateDiffusivity } from '../src/core/ep/calibrate';
import { CpuBackend } from '../src/core/ep/solver-cpu';
import { Simulation } from '../src/core/ep/simulation';
import { StimulusSchedule } from '../src/core/ep/stimulus';
import { LatentEctopyDriver, SourceDriver } from '../src/engine/drivers';
import { Rng } from '../src/core/rng';
import { Region } from '../src/core/mesh/regions';
import { SimEngine } from '../src/engine/engine';
import { DEFAULT_SIM_CONFIG } from '../src/engine/protocol';
import type { Simulation as Sim } from '../src/core/ep/simulation';
import { defaultAtrium } from './helpers';

describe('autonomic module (phenomenological)', () => {
  const { mesh } = defaultAtrium();
  const zones = buildGpZones(mesh, 1);
  const n = mesh.region.length;
  const base = new Float32Array(n).fill(1);

  it('four GP zones sit on the antra next to their veins', () => {
    expect(zones.map((z) => z.name)).toEqual(['Superior left GP', 'Inferior left GP', 'Anterior right GP', 'Inferior right GP']);
    const antrum: Record<string, number[]> = { LSPV: [Region.LSPVAntrum, Region.Roof, Region.LAA, Region.Lateral], LIPV: [Region.LIPVAntrum, Region.Inferior, Region.Posterior, Region.Lateral], RSPV: [Region.RSPVAntrum, Region.Septum, Region.Anterior, Region.Roof], RIPV: [Region.RIPVAntrum, Region.Inferior, Region.Posterior, Region.Septum] };
    for (const z of zones) {
      expect(antrum[z.pv]).toContain(mesh.region[z.centre]);
      expect(z.idx.length).toBeGreaterThan(20);
    }
    const d = gpDensity(zones, n);
    expect(Math.max(...d)).toBeLessThanOrEqual(1);
  });

  it('vagal tone shortens APD uniformly or mostly in GP zones; GP ablation removes the extra effect', () => {
    expect(autonomicApdScale(base, zones, null, { vagal: 0, sympathetic: 1, heterogeneous: true })).toEqual(base);
    const uni = autonomicApdScale(base, zones, null, { vagal: 1, sympathetic: 0, heterogeneous: false });
    expect(uni[0]).toBeCloseTo(1 - AUTONOMIC.uniformApd, 6);
    const het = autonomicApdScale(base, zones, null, { vagal: 1, sympathetic: 0, heterogeneous: true });
    const c = zones[0]!.centre;
    expect(het[c]!).toBeLessThan(0.62);
    // Far from every GP only the baseline shortening remains.
    const far = sinusSites(mesh)[1]!.vertices[0]!;
    expect(het[far]!).toBeCloseTo(1 - AUTONOMIC.baseApd, 2);
    // Lesions over the first GP zone: efficacy → 0 and its APD shortening reverts to baseline.
    const kind = new Uint8Array(n);
    for (const v of zones[0]!.idx) kind[v] = 2;
    expect(gpEfficacy(zones, kind)[0]).toBe(0);
    const ablated = autonomicApdScale(base, zones, kind, { vagal: 1, sympathetic: 0, heterogeneous: true });
    expect(ablated[c]!).toBeCloseTo(1 - AUTONOMIC.baseApd, 2);
  });

  it('sinus rate: vagal slows, sympathetic speeds', () => {
    expect(sinusClFactor({ vagal: 1, sympathetic: 0, heterogeneous: true })).toBeCloseTo(1.5);
    expect(sinusClFactor({ vagal: 0, sympathetic: 1, heterogeneous: true })).toBeCloseTo(1 / 1.6);
    const e = new SimEngine(() => {});
    return (async () => {
      await e.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'eikonal', sinusCl: 800 });
      await e.setAutonomic({ vagal: 1, sympathetic: 0, heterogeneous: true });
      expect(e.effectiveSinusCl()).toBe(1200);
    })();
  });

  it('in the tissue model, vagal tone shortens APD90 most at a GP centre', async () => {
    const p = PRESETS.healthy;
    const tissue = buildTissue(mesh, p, 1);
    const model = createIonicModel(p.ionic);
    const cal = await calibrateDiffusivity(p.ionic, p.targetCv, { h: tissue.geom.meanEdge, dt: model.recommendedDt });
    const apdAt = async (apdScale: Float32Array) => {
      const be = new CpuBackend({ geom: tissue.geom, model, edgeD: tissue.substrate.edgeDiffusivity(cal.D), apdScale, excitable: tissue.substrate.excitable(), siteOf: new Int32Array(n).fill(-1), dt: model.recommendedDt });
      const sim = new Simulation(be, model.recommendedDt);
      const s = sinusSites(mesh);
      s.forEach((site, k) => { sim.schedule.addSite({ name: site.name, vertices: site.vertices, amplitude: 0.5, duration: 2 }); sim.schedule.trains.push({ site: k, start: 1 + site.delay, period: Infinity, count: 1 }); });
      sim.markSitesChanged();
      await sim.advance(450);
      const a = be.readActivation();
      return (v: number) => a.repol[v]! - a.last[v]!;
    };
    const c = zones[0]!.centre, far = sinusSites(mesh)[1]!.vertices[0]!;
    const before = await apdAt(base);
    const after = await apdAt(autonomicApdScale(base, zones, null, { vagal: 1, sympathetic: 0, heterogeneous: true }));
    expect(after(c) / before(c)).toBeLessThan(0.75);
    expect(after(far) / before(far)).toBeGreaterThan(0.82);
  }, 120_000);

  it('sympathetic tone arms latent PV foci and makes triggers fire more often', () => {
    const fakeSim = () => {
      const schedule = new StimulusSchedule();
      schedule.addSite({ name: 'x', vertices: new Uint32Array([0]), amplitude: 0.6, duration: 2 });
      return { schedule, markSitesChanged() {} } as unknown as Sim;
    };
    const foci = ['LSPV', 'LIPV', 'RSPV', 'RIPV'].map((pv, k) => ({ pv, centre: k, vertices: Uint32Array.of(k), draw: [0.1, 0.4, 0.6, 0.9][k]! }));
    const bursts = (s: number) => {
      const d = new LatentEctopyDriver(fakeSim(), 0, foci, new Rng(3));
      d.setTone(s, 0);
      d.schedule(120_000);
      return d.bursts;
    };
    expect(bursts(0)).toBe(0);
    const half = bursts(0.5), full = bursts(1);
    // At s = 0.5 two of four foci are armed at rate 0.04/s; at s = 1 all four at 0.08/s.
    expect(half).toBeGreaterThan(2);
    expect(full).toBeGreaterThan(1.5 * half);
    expect(Math.abs(full - 0.08 * 4 * 120) / (0.08 * 4 * 120)).toBeLessThan(0.4);
    const trigger = (s: number) => {
      const sim = fakeSim();
      const drv = new SourceDriver(sim, 0, { name: 't', vertices: Uint32Array.of(0), centre: 0, mode: 'triggered', beats: [3, 8], cl: [170, 230], interval: [3500, 8000] }, new Rng(5), 0);
      drv.sympathetic = s;
      drv.schedule(120_000);
      return sim.schedule.trains.length;
    };
    expect(trigger(1)).toBeGreaterThan(1.5 * trigger(0));
  });
});
