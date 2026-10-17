import { describe, expect, it } from 'vitest';
import { SimEngine } from '../src/engine/engine';
import { DEFAULT_SIM_CONFIG, type FromWorker } from '../src/engine/protocol';
import { defaultAtrium } from './helpers';

function harness() {
  const msgs: FromWorker[] = [];
  const engine = new SimEngine((m) => msgs.push(m));
  const last = <T extends FromWorker['type']>(type: T) => [...msgs].reverse().find((m) => m.type === type) as Extract<FromWorker, { type: T }> | undefined;
  return { engine, msgs, last };
}

describe('simulation engine (worker host)', () => {
  const { mesh } = defaultAtrium();

  it('eikonal mode: ready report, frames, and wall-clock-paced playback at the target speed', async () => {
    const h = harness();
    await h.engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'eikonal' });
    const ready = h.last('ready')!;
    expect(ready.info.backend).toBe('eikonal');
    expect(ready.info.eikonalMs!).toBeLessThan(1000);
    expect(Math.abs(ready.info.cv / 0.75 - 1)).toBeLessThan(0.02);
    h.engine.setSpeed(0.05);
    h.engine.play();
    await new Promise((r) => setTimeout(r, 1200));
    h.engine.pause();
    await new Promise((r) => setTimeout(r, 50));
    const f = h.last('frame')!;
    // 1.2 s of wall time at 0.05× ≈ 60 ms simulated: the sinus wavefront is part-way across the LA.
    expect(f.t).toBeGreaterThan(40);
    expect(f.t).toBeLessThan(75);
    expect(f.v.length).toBe(mesh.region.length);
    const depolarized = Array.from(f.v).filter((x) => x > 0.5).length / f.v.length;
    expect(depolarized).toBeGreaterThan(0.2);
    expect(depolarized).toBeLessThan(0.9);
  });

  it('reaction–diffusion (CPU): single-step advances exactly and the GT activation map is available', async () => {
    const h = harness();
    await h.engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'rd', backend: 'cpu' });
    expect(h.last('ready')!.info.backend).toBe('cpu');
    await h.engine.step(10);
    expect(h.last('frame')!.t).toBeCloseTo(10, 6);
    await h.engine.step(120);
    await h.engine.requestActivation();
    const a = h.last('activation')!;
    const activated = Array.from(a.last).filter((x) => Number.isFinite(x)).length;
    expect(activated).toBeGreaterThan(0.95 * mesh.region.length);
  });

  it('reconfiguring the sinus cycle length does not rebuild the tissue', async () => {
    const h = harness();
    await h.engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'rd', backend: 'cpu' });
    const readies = h.msgs.filter((m) => m.type === 'ready').length;
    await h.engine.configure({ sinusCl: 600 });
    expect(h.msgs.filter((m) => m.type === 'ready').length).toBe(readies);
    await h.engine.configure({ preset: 'persistent' });
    expect(h.msgs.filter((m) => m.type === 'ready').length).toBe(readies + 1);
    expect(h.last('ready')!.info.fibroticFraction).toBeGreaterThan(0.1);
  });
});
