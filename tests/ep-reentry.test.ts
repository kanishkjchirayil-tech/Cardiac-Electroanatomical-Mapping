import { describe, expect, it } from 'vitest';
import { cylinderRing } from '../src/core/mesh/primitives';
import { buildGeometry } from '../src/core/ep/fem';
import { calibrateDiffusivity } from '../src/core/ep/calibrate';
import { PRESETS, type PresetId } from '../src/core/ep/tissue';
import { uniformSim } from './ep-helpers';

/**
 * Ring (open cylinder) reentry: a stimulus next to a transient conduction block launches a wave
 * in one direction only (unidirectional block). The block is released once the stimulated tissue
 * has repolarized, before the wave returns around the ring.
 */
async function ringRun(opts: { preset: PresetId; R: number; block: boolean; duration: number }) {
  const ring = cylinderRing(opts.R, 6, 0.955);
  const g = buildGeometry(ring.positions, ring.indices);
  const p = PRESETS[opts.preset];
  const cal = await calibrateDiffusivity(p.ionic, p.targetCv);
  const ang = (i: number) => (Math.atan2(g.positions[3 * i + 1]!, g.positions[3 * i]!) * 180) / Math.PI;
  const stim: number[] = [];
  for (let i = 0; i < g.nV; i++) if (ang(i) >= 0 && ang(i) < (5 * 20) / opts.R) stim.push(i);
  const { be, sim } = uniformSim(g, p.ionic, cal.D, [Uint32Array.from(stim)]);
  const edgeD = new Float32Array(g.edgeA.length).fill(cal.D);
  if (opts.block) {
    const blocked = edgeD.slice();
    const lim = (25 * 20) / opts.R;
    for (let e = 0; e < g.edgeA.length; e++) {
      const a = ang(g.edgeA[e]!), b = ang(g.edgeB[e]!);
      if (a < -1 !== b < -1 && Math.abs(a) < lim && Math.abs(b) < lim) blocked[e] = 0;
    }
    be.setEdgeDiffusivity(blocked);
  }
  sim.schedule.trains.push({ site: 0, start: 1, period: Infinity, count: 1 });
  await sim.advance(cal.apd90 + 40);
  be.setEdgeDiffusivity(edgeD);
  // Record activation times at a probe opposite the stimulus.
  const probe = (() => {
    let b = 0;
    for (let i = 0; i < g.nV; i++) if (Math.abs(ang(i) - 180) < Math.abs(ang(b) - 180) && g.positions[3 * i + 2]! > 2) b = i;
    return b;
  })();
  const times: number[] = [];
  let lastCount = be.readActivation().count[probe]!;
  if (lastCount > 0) times.push(be.readActivation().last[probe]!);
  while (sim.t < opts.duration) {
    await sim.advance(20);
    const a = be.readActivation();
    if (a.count[probe]! > lastCount) {
      times.push(a.last[probe]!);
      lastCount = a.count[probe]!;
    }
  }
  const v = be.readV();
  const active = v.reduce((n, x) => n + (x > 0.5 ? 1 : 0), 0);
  return { times, active, circumference: 2 * Math.PI * opts.R, cv: p.targetCv };
}

describe('reentry on a ring after unidirectional block', () => {
  it.each(['persistent', 'healthy'] as const)('%s tissue: anatomical reentry sustains around a 12.6 cm circuit', async (preset) => {
    const r = await ringRun({ preset, R: 20, block: true, duration: 3000 });
    // Sustained: activations keep arriving at the probe for the whole 3 s.
    expect(r.times.length).toBeGreaterThanOrEqual(10);
    expect(r.times[r.times.length - 1]!).toBeGreaterThan(2600);
    const cls = r.times.slice(1).map((t, i) => t - r.times[i]!).slice(2);
    const mean = cls.reduce((a, b) => a + b, 0) / cls.length;
    const sd = Math.sqrt(cls.reduce((a, b) => a + (b - mean) ** 2, 0) / cls.length);
    expect(sd / mean).toBeLessThan(0.05); // stable cycle length
    // Cycle length ≈ path / CV, lengthened by CV restitution at short diastolic intervals.
    expect(mean).toBeGreaterThan(r.circumference / r.cv);
    expect(mean).toBeLessThan((1.6 * r.circumference) / r.cv);
  });

  it('control: without the block the two wavefronts collide and the ring falls silent', async () => {
    const r = await ringRun({ preset: 'persistent', R: 20, block: false, duration: 1200 });
    expect(r.times.length).toBe(1);
    expect(r.active).toBe(0);
  });

  it('control: a circuit shorter than the wavelength cannot sustain reentry', async () => {
    const r = await ringRun({ preset: 'healthy', R: 6, block: true, duration: 1500 });
    expect(r.times.length).toBeLessThanOrEqual(2);
    expect(r.active).toBe(0);
  });
});
