import { describe, expect, it } from 'vitest';
import { Region } from '../src/core/mesh/regions';
import { antralRing } from '../src/core/ablation/rings';
import { startCase, median } from './case-helpers';

const LONG = 400_000;

describe('pacing in the reaction–diffusion engine', () => {
  it('CS pacing captures above threshold, overdrives the sinus rhythm, and fails below threshold', async () => {
    const c = await startCase('sinus', 1);
    await c.run(1000);
    c.refCls.length = 0;
    const st = await c.pace({ site: 'cs-distal', output: 5, protocol: { kind: 'fixed', cl: 500, count: 6 } }, 4500);
    expect(c.error()).toBeUndefined();
    expect(st.active).toBe(false);
    expect(st.localCapture).toBe(true);
    // The CS reference follows the pacing cycle length (sinus beats are overdriven).
    expect(Math.abs(median(c.refCls.slice(1, 5)) - 500)).toBeLessThan(15);
    // Nearest bipole first; the far end of the CS later.
    const iv = Object.fromEntries(st.intervals.map((i) => [i.channel, i.ms]));
    expect(iv['CS 3-4']!).toBeLessThan(40);
    expect(iv['CS 9-10']!).toBeGreaterThan(iv['CS 3-4']!);
    const sub = await c.pace({ site: 'cs-distal', output: 0.2, protocol: { kind: 'fixed', cl: 500, count: 4 } }, 3500);
    expect(sub.localCapture).toBe(false);
    const log = (await c.report()).pacingLog;
    expect(log).toHaveLength(2);
    expect(log[0]!.captureTruth).toBeGreaterThan(0.8);
    expect(log[1]!.captureTruth).toBe(0);
  }, LONG);

  it('entrainment of perimitral flutter: PPI − TCL is short on the annulus and long in the LAA', async () => {
    const c = await startCase('pmf', 1);
    const P = c.mesh.positions;
    await c.run(2000);
    // In-circuit site: the mitral annulus, far from the lateral isthmus and off the old lesions.
    const lipv = c.tools.loop('LIPV');
    const kind = c.lesionKind();
    const mv = c.tools.loop('MV').filter((x) => !kind[x]);
    const far = mv.reduce((b, x) => (c.tools.distance(x, lipv[0]!) > c.tools.distance(b, lipv[0]!) ? x : b));
    const site = far;
    await c.engine.placeRoving(site);
    await c.run(1200);
    const inCircuit = await c.pace({ site: 'roving', output: 10, protocol: { kind: 'entrain', cl: 250, count: 8 } }, 4000);
    expect(inCircuit.entrain).not.toBeNull();
    expect(Math.abs(inCircuit.entrain!.tcl - 275)).toBeLessThan(25);
    expect(Math.abs(inCircuit.entrain!.diff)).toBeLessThan(30);
    // Bystander: the LAA tip.
    const base = c.mesh.anatomy!.laa.base;
    let tip = -1, td = -1;
    c.mesh.region.forEach((r, i) => {
      if (r !== Region.LAA) return;
      const d = Math.hypot(P[3 * i]! - base[0], P[3 * i + 1]! - base[1], P[3 * i + 2]! - base[2]);
      if (d > td) { td = d; tip = i; }
    });
    await c.engine.placeRoving(tip);
    await c.run(1200);
    const bystander = await c.pace({ site: 'roving', output: 10, protocol: { kind: 'entrain', cl: 250, count: 8 } }, 4000);
    expect(bystander.entrain!.diff).toBeGreaterThan(60);
  }, LONG);

  it('PV exit block: pacing inside the vein conducts to the CS before isolation and not after', async () => {
    const c = await startCase('paf', 2);
    const sleeve = c.mesh.region.findIndex((r) => r === Region.LSPV);
    const lm = c.mesh.anatomy!.pvs.find((p) => p.name === 'LSPV')!;
    // A sleeve vertex ≈ 6 mm into the vein.
    let inVein = sleeve, best = Infinity;
    c.mesh.region.forEach((r, i) => {
      if (r !== Region.LSPV) return;
      const q = [0, 1, 2].map((k) => c.mesh.positions[3 * i + k]! - (lm.ostiumCenter[k]! + 6 * lm.axis[k]!));
      const d = Math.hypot(...q);
      if (d < best) { best = d; inVein = i; }
    });
    await c.engine.placeRoving(inVein);
    await c.run(1200);
    const before = await c.pace({ site: 'roving', output: 10, protocol: { kind: 'fixed', cl: 450, count: 6 } }, 3500);
    expect(before.localCapture).toBe(true);
    expect(before.csFollows).toBe(true);
    await c.burn(antralRing(c.mesh, 'LSPV', 5, 4));
    await c.engine.placeRoving(inVein);
    await c.run(1200);
    const after = await c.pace({ site: 'roving', output: 10, protocol: { kind: 'fixed', cl: 450, count: 6 } }, 3500);
    expect(after.localCapture).toBe(true);
    expect(after.csFollows).toBe(false);
    const r = await c.report();
    expect(r.pv.find((p) => p.pv === 'LSPV')!.durable).toBe(true);
  }, LONG);
});
