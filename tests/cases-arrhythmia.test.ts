import { describe, expect, it } from 'vitest';
import { antralRing } from '../src/core/ablation/rings';
import { startCase, along } from './case-helpers';

const LONG = 400_000;

describe('scenario arrhythmias and their ablation endpoints', () => {
  it('perimitral flutter: regular tachycardia; a mitral isthmus line terminates it and blocks', async () => {
    const c = await startCase('pmf', 2);
    await c.run(2000);
    const tach = c.refCls.slice(-4);
    expect(Math.max(...tach)).toBeLessThan(330);
    expect(Math.max(...tach) - Math.min(...tach)).toBeLessThan(25);
    const left = antralRing(c.mesh, ['LSPV', 'LIPV'], 7, 4);
    await c.burn(along(c.tools, c.tools.path(c.tools.loop('MV'), left), 3), 45, 30);
    await c.run(2500);
    const r = await c.report();
    expect(r.mitralBlock.durable).toBe(true);
    expect(r.roofBlock.durable).toBe(false);
    expect(r.rhythm).toBe('sinus');
  }, LONG);

  it('roof-dependent flutter: a roof line joining the PV isolation lines terminates it', async () => {
    const c = await startCase('roof', 3);
    const P = c.mesh.positions;
    // The case switches to a live CS bipole at 1.5 s (CS 7-8 lies over the old ring); the tachycardia CL then reads ≈ 330 ms.
    await c.run(3000);
    expect(c.refCls.slice(-2).every((cl) => cl > 280 && cl < 400)).toBe(true);
    const left = antralRing(c.mesh, ['LSPV', 'LIPV'], 7, 4), right = antralRing(c.mesh, ['RSPV', 'RIPV'], 7, 4);
    await c.burn(along(c.tools, c.tools.path(left.filter((v) => P[3 * v + 2]! > 10), right.filter((v) => P[3 * v + 2]! > 10))));
    await c.run(2500);
    const r = await c.report();
    expect(r.roofBlock.durable).toBe(true);
    expect(r.rhythm).toBe('sinus');
  }, LONG);

  it('focal AT: ablation at the focus eliminates it and sinus rhythm resumes', async () => {
    const c = await startCase('focal', 1);
    await c.run(2000);
    const before = await c.report();
    expect(before.rhythm).toBe('not-sinus');
    await c.burn([before.truth!.focusVertex!]);
    await c.run(2500);
    const r = await c.report();
    expect(r.sources[0]!.eliminated).toBe(true);
    expect(r.rhythm).toBe('sinus');
  }, LONG);

  it('persistent AF: sustained, irregular, and cardioversion restores sinus rhythm', async () => {
    const c = await startCase('persistent', 3);
    await c.run(3000);
    const cls = c.refCls.slice(-8);
    expect((await c.report()).rhythm).toBe('not-sinus');
    const mean = cls.reduce((a, b) => a + b, 0) / cls.length;
    expect(mean).toBeLessThan(260);
    expect(Math.max(...cls) - Math.min(...cls)).toBeGreaterThan(15);
    await c.engine.cardiovert();
    await c.run(2500);
    const r = await c.report();
    expect(r.cardioversions).toBe(1);
    expect(r.rhythm).toBe('sinus');
  }, LONG);
});
