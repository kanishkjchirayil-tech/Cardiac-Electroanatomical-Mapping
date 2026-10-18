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

describe('electrogram streaming', () => {
  const { mesh } = defaultAtrium();

  it('eikonal mode streams contiguous 2 kHz samples for all channels and the roving pose', async () => {
    const h = harness();
    await h.engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'eikonal' });
    const ready = h.last('ready')!;
    const nCh = ready.rig.channels.length;
    expect(ready.rig.channels.map((c) => c.name)).toEqual(['I', 'II', 'V1', 'CS 9-10', 'CS 7-8', 'CS 5-6', 'CS 3-4', 'CS 1-2', 'MAP 1-2', 'MAP 3-4', 'MAP 1 uni', 'MAP 2 uni']);
    h.msgs.length = 0;
    await h.engine.step(500);
    await h.engine.step(500);
    const chunks = h.msgs.filter((m): m is Extract<FromWorker, { type: 'frame' }> => m.type === 'frame' && !!m.egm).map((m) => m.egm!);
    const total = chunks.reduce((a, c) => a + c.n, 0);
    expect(Math.abs(total - 2000)).toBeLessThanOrEqual(2);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.t0).toBeCloseTo(chunks[i - 1]!.t0 + chunks[i - 1]!.n * 0.5, 6);
    expect(chunks[0]!.nCh).toBe(nCh);
    const f = h.last('frame')!;
    expect(f.roving).not.toBeNull();
    expect(f.roving!.electrodes.length).toBe(12);
  });

  it('moving the roving catheter changes the local activation time it records', async () => {
    const h = harness();
    await h.engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'eikonal', sinusCl: 800 });
    await h.engine.setMotion(false);
    const ch = h.last('ready')!.rig.channels.findIndex((c) => c.name === 'MAP 1-2');
    const peakTime = async (vertex: number) => {
      await h.engine.placeRoving(vertex);
      h.msgs.length = 0;
      await h.engine.step(800);
      const chunks = h.msgs.filter((m): m is Extract<FromWorker, { type: 'frame' }> => m.type === 'frame' && !!m.egm).map((m) => m.egm!);
      let best = 0, bt = 0;
      for (const c of chunks) for (let s = 0; s < c.n; s++) {
        const v = Math.abs(c.data[s * c.nCh + ch]!);
        if (v > best) { best = v; bt = (c.t0 + s * 0.5) % 800; }
      }
      return bt;
    };
    const { sinusSites } = await import('../src/core/ep/tissue');
    const early = await peakTime(sinusSites(mesh)[0]!.vertices[0]!);
    let lateral = 0;
    for (let i = 0; i < mesh.region.length; i++) if (mesh.positions[3 * i]! > mesh.positions[3 * lateral]! && mesh.region[i] !== 15) lateral = i;
    const late = await peakTime(lateral);
    expect(late - early).toBeGreaterThan(50);
  });
});
