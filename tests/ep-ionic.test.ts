import { describe, expect, it } from 'vitest';
import { createIonicModel, MS_ATRIAL_DEFAULT } from '../src/core/ep/ionic';
import { makeApTemplate } from '../src/core/ep/ap-template';

/** Single-cell run: returns peak, APD90 and whether the cell stays at rest without stimulus. */
function cell(id: 'ms' | 'ap' | 'fk', stimulate: boolean) {
  const m = createIonicModel({ id });
  const [v0, a, b] = m.restState();
  const v = Float32Array.of(v0), g0 = Float32Array.of(a), g1 = Float32Array.of(b);
  const apd = Float32Array.of(1), exc = Uint8Array.of(1);
  const dt = m.recommendedDt;
  let peak = 0, tUp = NaN, tDown = NaN;
  for (let k = 0; k * dt < 1000; k++) {
    const t = k * dt;
    const prev = v[0]!;
    if (stimulate && t < 2) v[0] = v[0]! + dt * 0.5;
    m.react(v, g0, g1, 1, dt, apd, exc);
    peak = Math.max(peak, v[0]!);
    if (Number.isNaN(tUp) && prev < 0.5 && v[0]! >= 0.5) tUp = t;
    if (!Number.isNaN(tUp) && Number.isNaN(tDown) && prev > 0.1 && v[0]! <= 0.1) tDown = t;
  }
  return { peak, apd90: tDown - tUp, final: v[0]! };
}

describe.each(['ms', 'ap', 'fk'] as const)('ionic model %s', (id) => {
  it('is stable at rest without stimulus', () => {
    const r = cell(id, false);
    expect(r.peak).toBeLessThan(0.05);
  });

  it('fires an action potential that fully repolarizes', () => {
    const r = cell(id, true);
    expect(r.peak).toBeGreaterThan(0.8);
    expect(r.apd90).toBeGreaterThan(100);
    expect(r.apd90).toBeLessThan(400);
    expect(Math.abs(r.final)).toBeLessThan(0.05);
  });

  it('provides a WGSL reaction kernel with the shared signature', () => {
    const src = createIonicModel({ id }).wgsl();
    expect(src).toMatch(/fn react\([^)]*apd: f32, dt: f32, excitable: bool\) -> vec3<f32>/);
  });
});

describe('Mitchell–Schaeffer', () => {
  it('APD90 is close to the analytic maximum τclose·ln(τout/4τin)', () => {
    const p = MS_ATRIAL_DEFAULT;
    const predicted = p.tauClose * Math.log(p.tauOut / (4 * p.tauIn));
    const r = cell('ms', true);
    // The formula is an asymptotic estimate of when the plateau collapses; APD90 additionally
    // includes the repolarization downstroke, so it runs ~20 % longer.
    expect(r.apd90).toBeGreaterThan(predicted);
    expect(r.apd90 / predicted - 1).toBeLessThan(0.25);
  });

  it('apdScale shortens the action potential (remodeling)', () => {
    const m = createIonicModel({ id: 'ms' });
    const long = makeApTemplate(m, 1), short = makeApTemplate(m, 0.5);
    const apd = (tpl: ReturnType<typeof makeApTemplate>) => {
      for (let t = 5; t < 600; t += 0.5) if (tpl.at(t) < 0.1) return t;
      return NaN;
    };
    expect(apd(short)).toBeLessThan(0.65 * apd(long));
  });
});
