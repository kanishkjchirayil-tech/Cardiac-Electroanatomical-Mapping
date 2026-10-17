import { describe, expect, it } from 'vitest';
import { calibrateDiffusivity, measureConduction, measureRestitution } from '../src/core/ep/calibrate';
import { hexSheet } from '../src/core/mesh/primitives';
import { PRESETS } from '../src/core/ep/tissue';
import { select, uniformSim } from './ep-helpers';

describe('conduction velocity calibration (flat sheet, h = 0.955 mm)', () => {
  it.each(['ms', 'ap', 'fk'] as const)('%s: calibrated plane-wave CV is within 10 %% of 0.75 m/s', async (id) => {
    const c = await calibrateDiffusivity({ id }, 0.75, { dt: id === 'ms' ? 0.1 : 0.05 });
    expect(Math.abs(c.cv / 0.75 - 1)).toBeLessThan(0.1);
    // Independent re-measurement on a longer strip.
    const r = await measureConduction({ id }, c.D, { dt: id === 'ms' ? 0.1 : 0.05, length: 60 });
    expect(Math.abs(r.cv / 0.75 - 1)).toBeLessThan(0.1);
  });

  it('calibrates every preset to its target within 2 %', async () => {
    for (const p of Object.values(PRESETS)) {
      const c = await calibrateDiffusivity(p.ionic, p.targetCv);
      expect(Math.abs(c.cv / p.targetCv - 1), p.id).toBeLessThan(0.02);
    }
  });

  it('conduction is near-isotropic on the lattice (x vs y direction within 10 %)', async () => {
    const c = await calibrateDiffusivity({ id: 'ms' }, 0.75);
    const sheet = hexSheet(40, 40, 0.955);
    const run = async (axis: 0 | 1) => {
      const { be, sim, geom } = uniformSim(sheet, { id: 'ms' }, c.D, [select({ positions: sheet.positions, nV: sheet.positions.length / 3 }, (x, y) => (axis === 0 ? x : y) < 1.5)]);
      sim.schedule.trains.push({ site: 0, start: 1, period: Infinity, count: 1 });
      await sim.advance(120);
      const a = be.readActivation();
      const at = (u: number) => {
        const vs = select(geom, (x, y) => Math.abs((axis === 0 ? x : y) - u) < 0.5 && Math.abs((axis === 0 ? y : x) - 20) < 10);
        return Array.from(vs, (v) => a.last[v]!).reduce((s, t) => s + t, 0) / vs.length;
      };
      return 20 / (at(30) - at(10));
    };
    const cx = await run(0), cy = await run(1);
    expect(Math.abs(cx / cy - 1)).toBeLessThan(0.1);
  });
});

describe('restitution (S1–S2, 1D strip)', () => {
  it('healthy MS: APD and CV fall at short diastolic intervals; ERP in the atrial range', async () => {
    const p = PRESETS.healthy;
    const c = await calibrateDiffusivity(p.ionic, p.targetCv);
    const r = await measureRestitution(p.ionic, c.D, { step: 10 });
    expect(r.points.length).toBeGreaterThan(10);
    const byDi = [...r.points].sort((a, b) => a.di - b.di);
    const first = byDi[0]!, last = byDi[byDi.length - 1]!;
    expect(first.apd90).toBeLessThan(0.85 * last.apd90);
    expect(first.cv).toBeLessThan(0.85 * last.cv);
    // Monotone within measurement noise (1 ms / 1 %).
    for (let i = 1; i < byDi.length; i++) {
      expect(byDi[i]!.apd90).toBeGreaterThan(byDi[i - 1]!.apd90 - 1);
      expect(byDi[i]!.cv).toBeGreaterThan(byDi[i - 1]!.cv * 0.99);
    }
    expect(r.erp).toBeGreaterThanOrEqual(180);
    expect(r.erp).toBeLessThanOrEqual(320);
  });

  it('electrical remodeling (persistent preset) shortens ERP substantially', async () => {
    const h = PRESETS.healthy, q = PRESETS.persistent;
    const ch = await calibrateDiffusivity(h.ionic, h.targetCv), cq = await calibrateDiffusivity(q.ionic, q.targetCv);
    const rh = await measureRestitution(h.ionic, ch.D, { step: 20 });
    const rq = await measureRestitution(q.ionic, cq.D, { step: 20 });
    expect(rq.erp).toBeLessThan(0.7 * rh.erp);
    expect(cq.apd90).toBeGreaterThan(90);
    expect(cq.apd90).toBeLessThan(150);
  });
});
