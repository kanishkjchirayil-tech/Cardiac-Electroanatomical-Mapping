import { describe, expect, it } from 'vitest';
import { calibrateDiffusivity } from '../src/core/ep/calibrate';
import { createIonicModel } from '../src/core/ep/ionic';
import { CpuBackend } from '../src/core/ep/solver-cpu';
import { Simulation } from '../src/core/ep/simulation';
import { PRESETS, buildTissue, sinusSites } from '../src/core/ep/tissue';
import { Region } from '../src/core/mesh/regions';
import { getV } from '../src/core/math/vec3';
import { contactCoupling, interLesionDistances, lesionSize, lesionQuality } from '../src/core/ablation/lesion';
import { RfApplication, RF_CONSTANTS } from '../src/core/ablation/rf';
import { AblationController, DEFAULT_ABLATION, applyLesionsToSubstrate, type AblationSettings } from '../src/core/ablation/controller';
import { antralRing } from '../src/core/ablation/rings';
import { buildEsophagus } from '../src/core/ablation/esophagus';
import type { LesionFields } from '../src/core/ablation/lesion';
import { defaultAtrium } from './helpers';

const GOOD: AblationSettings = { ...DEFAULT_ABLATION, power: 35, duration: 20 };

/** Activation counts after one beat: sinus rhythm (or a single stimulus inside the LSPV sleeve). */
async function beatWithLesions(fields: LesionFields | null, from: 'sinus' | 'lspv') {
  const { mesh } = defaultAtrium();
  const p = PRESETS.healthy;
  const tissue = buildTissue(mesh, p, 1);
  if (fields) applyLesionsToSubstrate(tissue.substrate, fields);
  const model = createIonicModel(p.ionic);
  const cal = await calibrateDiffusivity(p.ionic, p.targetCv, { h: tissue.geom.meanEdge, dt: model.recommendedDt });
  const n = tissue.geom.nV;
  const be = new CpuBackend({
    geom: tissue.geom, model, edgeD: tissue.substrate.edgeDiffusivity(cal.D), apdScale: tissue.substrate.apdScale,
    excitable: tissue.substrate.excitable(), siteOf: new Int32Array(n).fill(-1), dt: model.recommendedDt,
  });
  const sim = new Simulation(be, model.recommendedDt);
  if (from === 'sinus') {
    sinusSites(mesh).forEach((s, k) => {
      sim.schedule.addSite({ name: s.name, vertices: s.vertices, amplitude: 0.5, duration: 2 });
      sim.schedule.trains.push({ site: k, start: 1 + s.delay, period: Infinity, count: 1 });
    });
  } else {
    // Distal sleeve: LSPV vertices farthest along the vein axis.
    const lm = mesh.anatomy!.pvs.find((v) => v.name === 'LSPV')!;
    const along = (i: number) => { const q = getV(mesh.positions, i); return (q[0] - lm.ostiumCenter[0]) * lm.axis[0] + (q[1] - lm.ostiumCenter[1]) * lm.axis[1] + (q[2] - lm.ostiumCenter[2]) * lm.axis[2]; };
    const sleeve = Array.from(mesh.region.keys()).filter((i) => mesh.region[i] === Region.LSPV).sort((a, b) => along(b) - along(a)).slice(0, 12);
    sim.schedule.addSite({ name: 'LSPV', vertices: Uint32Array.from(sleeve), amplitude: 0.5, duration: 2 });
    sim.schedule.trains.push({ site: 0, start: 1, period: Infinity, count: 1 });
  }
  sim.markSitesChanged();
  await sim.advance(320);
  const act = be.readActivation();
  const frac = (pred: (r: number) => boolean) => {
    let hit = 0, tot = 0;
    for (let i = 0; i < n; i++) if (pred(mesh.region[i]!)) { tot++; if (act.count[i]! > 0) hit++; }
    return hit / tot;
  };
  return {
    lspv: frac((r) => r === Region.LSPV),
    body: frac((r) => r === Region.Lateral || r === Region.Septum || r === Region.Anterior),
  };
}

function ringFields(settings: AblationSettings, force: number, opts: { skip?: number[]; edemaNow?: number } = {}) {
  const { mesh } = defaultAtrium();
  const ctl = new AblationController(mesh, new Uint8Array(mesh.region.length));
  const ring = antralRing(mesh, 'LSPV', 5, 4);
  ring.forEach((v, k) => { if (!opts.skip?.includes(k)) ctl.deliver(v, getV(mesh.positions, v), settings, force, 0); });
  return { ctl, fields: ctl.rasterize(opts.edemaNow ?? 0) };
}

describe('RF lesion model', () => {
  it('lesion size grows monotonically with power, time and force, and saturates', () => {
    const size = (P: number, t: number, F: number) => lesionSize(P * t * contactCoupling(F), P);
    expect(size(40, 20, 15).depth).toBeGreaterThan(size(25, 20, 15).depth);
    expect(size(30, 30, 15).depth).toBeGreaterThan(size(30, 10, 15).depth);
    expect(size(30, 20, 25).diameter).toBeGreaterThan(size(30, 20, 5).diameter);
    expect(size(50, 600, 40).depth).toBeLessThan(6.01);
    expect(size(50, 600, 40).diameter).toBeLessThan(10.01);
    // Standard settings: a few mm deep, ≈ 5–8 mm wide.
    const s = size(30, 30, 15);
    expect(s.depth).toBeGreaterThan(2.5);
    expect(s.depth).toBeLessThan(4.5);
    expect(s.diameter).toBeGreaterThan(5);
    expect(s.diameter).toBeLessThan(8.5);
    // Very low force barely couples energy.
    expect(size(30, 30, 2).depth).toBeLessThan(0.4 * s.depth);
    expect(lesionQuality(2, 2)).toBeCloseTo(10);
  });

  it('RF readout: impedance falls, FTI integrates force, esophageal temperature rises in the zone', () => {
    const rf = new RfApplication({ power: 40, duration: 30 }, 1.5, true);
    const z0 = rf.readout().impedance;
    let prevDrop = 0;
    for (let k = 0; k < 30; k++) {
      rf.step(1, 20);
      const r = rf.readout();
      expect(r.impedanceDrop).toBeGreaterThanOrEqual(prevDrop);
      prevDrop = r.impedanceDrop;
    }
    const r = rf.readout();
    expect(r.done).toBe(true);
    expect(r.fti).toBeCloseTo(600, 5);
    expect(r.impedance).toBeLessThan(z0);
    expect(r.impedanceDrop).toBeGreaterThan(8);
    expect(r.esophagealTemp).toBeGreaterThan(RF_CONSTANTS.tempWarning);
    const low = new RfApplication({ power: 20, duration: 5 }, 1.5, true);
    for (let k = 0; k < 5; k++) low.step(1, 8);
    expect(low.readout().esophagealTemp).toBeLessThan(RF_CONSTANTS.tempWarning);
    const outside = new RfApplication({ power: 40, duration: 30 }, 1.5, false);
    outside.step(30, 20);
    expect(Number.isNaN(outside.readout().esophagealTemp)).toBe(true);
  });

  it('esophageal zone lies on the posterior wall', () => {
    const { mesh } = defaultAtrium();
    const eso = buildEsophagus(mesh, 1);
    let n = 0, post = 0;
    eso.zone.forEach((z, i) => { if (z) { n++; if (mesh.normals[3 * i + 1]! > 0.5) post++; } });
    expect(n).toBeGreaterThan(100);
    expect(post).toBe(n);
  });

  it('interlesion distances and the 6 mm gap rule', () => {
    const { mesh } = defaultAtrium();
    const ring = antralRing(mesh, 'LSPV', 5, 4);
    const d = interLesionDistances(ring.map((v) => ({ center: getV(mesh.positions, v) })));
    expect(Number.isNaN(d[0]!)).toBe(true);
    expect(Math.max(...d.slice(1))).toBeLessThan(DEFAULT_ABLATION.gapThreshold);
    const gapped = ring.filter((_, k) => k !== 10 && k !== 11);
    const dg = interLesionDistances(gapped.map((v) => ({ center: getV(mesh.positions, v) })));
    expect(Math.max(...dg.slice(1))).toBeGreaterThan(DEFAULT_ABLATION.gapThreshold);
  });
});

describe('ablation changes conduction', () => {
  it('baseline: a sinus beat activates the LSPV sleeve', async () => {
    const r = await beatWithLesions(null, 'sinus');
    expect(r.lspv).toBeGreaterThan(0.99);
  });

  it('complete transmural antral ring around the LSPV gives entrance and exit block', async () => {
    const { fields } = ringFields(GOOD, 15);
    const entrance = await beatWithLesions(fields, 'sinus');
    expect(entrance.body).toBeGreaterThan(0.99);
    expect(entrance.lspv).toBe(0);
    const exit = await beatWithLesions(fields, 'lspv');
    expect(exit.lspv).toBeGreaterThan(0.5);
    expect(exit.body).toBe(0);
  });

  it('a deliberate gap in the ring preserves conduction into the vein', async () => {
    const { fields } = ringFields(GOOD, 15, { skip: [10, 11] });
    const r = await beatWithLesions(fields, 'sinus');
    expect(r.lspv).toBeGreaterThan(0.95);
  });

  it('a low-force, non-transmural ring leaves conduction intact', async () => {
    const { ctl, fields } = ringFields({ ...GOOD, power: 20, duration: 10 }, 3);
    expect(ctl.lesions.every((l) => l.lqi < 10)).toBe(true);
    expect(fields.core.some((c) => c === 1)).toBe(false);
    const r = await beatWithLesions(fields, 'sinus');
    expect(r.lspv).toBeGreaterThan(0.95);
  });

  it('edema: acute block, then reconnection once the edema resolves', async () => {
    const settings = { ...GOOD, power: 25, duration: 16, edema: true, edemaRecoverySec: 30 };
    const { ctl } = ringFields(settings, 10);
    expect(ctl.lesions.every((l) => l.lqi < 10)).toBe(true);
    const acute = await beatWithLesions(ctl.rasterize(1000), 'sinus');
    expect(acute.lspv).toBe(0);
    expect(ctl.nextEdemaExpiry(1000)).toBe(30_000);
    const late = await beatWithLesions(ctl.rasterize(31_000), 'sinus');
    expect(late.lspv).toBeGreaterThan(0.95);
  });
});

describe('ablation in the simulation engine', () => {
  it('RF runs on the accelerated clock, reports live readouts and isolates the vein (eikonal)', async () => {
    const { SimEngine } = await import('../src/engine/engine');
    const { DEFAULT_SIM_CONFIG } = await import('../src/engine/protocol');
    type Msg = import('../src/engine/protocol').FromWorker;
    const { mesh } = defaultAtrium();
    const msgs: Msg[] = [];
    const last = <T extends Msg['type']>(type: T) => [...msgs].reverse().find((m) => m.type === type) as Extract<Msg, { type: T }> | undefined;
    const engine = new SimEngine((m) => msgs.push(m));
    await engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'eikonal' });
    const ring = antralRing(mesh, 'LSPV', 5, 4);
    engine.setAblationSettings({ ...GOOD, timeScale: 10 });
    await engine.placeRoving(ring[0]!);
    await engine.step(1100); // let the catheter settle
    await engine.rfStart(false);
    await engine.step(1000); // 10 s of RF
    const live = last('frame')!.rf!;
    expect(live.elapsed).toBeGreaterThan(9);
    expect(live.elapsed).toBeLessThan(11);
    expect(live.impedanceDrop).toBeGreaterThan(0);
    expect(live.fti).toBeGreaterThan(0);
    await engine.step(1200);
    expect(last('frame')!.rf).toBeNull();
    const done = last('lesions')!;
    expect(done.lesions).toHaveLength(1);
    expect(done.lesions[0]!.duration).toBeCloseTo(20, 5);
    expect(done.lesions[0]!.active).toBe(false);
    // Complete the ring with instant applications.
    for (const v of ring.slice(1)) {
      await engine.placeRoving(v);
      await engine.rfStart(true);
    }
    expect(last('lesions')!.lesions).toHaveLength(ring.length);
    await engine.requestActivation();
    const a = last('activation')!;
    let reached = 0, sleeve = 0;
    mesh.region.forEach((r, i) => { if (r === Region.LSPV) { sleeve++; if (Number.isFinite(a.last[i]!)) reached++; } });
    expect(reached / sleeve).toBe(0);
    expect(a.lesion.some((k) => k === 2)).toBe(true);
    await engine.resetLesions();
    await engine.requestActivation();
    expect(last('lesions')!.lesions).toHaveLength(0);
  });
});
