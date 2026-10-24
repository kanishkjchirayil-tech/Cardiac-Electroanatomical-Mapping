import { describe, expect, it } from 'vitest';
import { protocolEnd, protocolTimes } from '../src/core/pacing/protocols';
import { CAPTURE, captureFootprint } from '../src/core/pacing/capture';
import { SignalHistory, activations, cycleLengthOf, firstActivation } from '../src/core/pacing/analysis';
import { SpatialGrid } from '../src/core/mesh/spatial';
import { gridMesh } from './helpers';

describe('pacing protocols', () => {
  it('fixed, burst and S1–S2 stimulus times', () => {
    expect(protocolTimes({ kind: 'burst', cl: 200, count: 4 }, 100)).toEqual([100, 300, 500, 700]);
    expect(protocolTimes({ kind: 's1s2', s1: 600, n: 3, s2: 280 }, 0)).toEqual([0, 600, 1200, 1480]);
    expect(protocolTimes({ kind: 's1s2', s1: 500, n: 2, s2: 250, s3: 220 }, 0)).toEqual([0, 500, 750, 970]);
    expect(protocolTimes({ kind: 'fixed', cl: 500, count: Infinity }, 0, 1600)).toEqual([0, 500, 1000, 1500]);
    expect(protocolEnd({ kind: 'fixed', cl: 500, count: Infinity }, 0)).toBe(Infinity);
    expect(protocolEnd({ kind: 'entrain', cl: 250, count: 8 }, 10)).toBe(10 + 7 * 250);
  });
});

describe('capture model', () => {
  const g = gridMesh(40, 1);
  const grid = new SpatialGrid(g.positions, 2);
  const healthy = () => 1;
  const p: [number, number, number] = [20, 20, 0];

  it('threshold rises with the electrode–tissue gap and the footprint grows with output', () => {
    const contact = captureFootprint(grid, g.positions, p, 1, healthy, 0);
    const far = captureFootprint(grid, g.positions, p, 1, healthy, 3);
    expect(contact.threshold).toBeCloseTo(CAPTURE.i0, 6);
    expect(far.threshold).toBeCloseTo(CAPTURE.i0 * 10, 6);
    expect(contact.aboveThreshold).toBe(true);
    expect(far.aboveThreshold).toBe(false);
    expect(far.vertices.length).toBe(0);
    const strong = captureFootprint(grid, g.positions, p, 10, healthy, 0);
    expect(strong.vertices.length).toBeGreaterThan(contact.vertices.length);
    expect(strong.amplitude).toBeGreaterThan(contact.amplitude);
  });

  it('scar does not capture and a partial lesion raises the threshold', () => {
    expect(captureFootprint(grid, g.positions, p, 20, () => 0, 0).aboveThreshold).toBe(false);
    const half = captureFootprint(grid, g.positions, p, 1, () => 0.5, 0);
    expect(half.threshold).toBeCloseTo(2 * CAPTURE.i0, 6);
  });
});

describe('signal analysis', () => {
  // Synthetic bipolar channel at 2 kHz: a biphasic deflection every 300 ms starting at 40 ms.
  const fs = 2000;
  const h = new SignalHistory(1, fs, 4);
  const n = 2 * fs;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / fs;
    const ph = (t - 40) % 300;
    if (t >= 40 && ph < 6) data[i] = Math.sin((ph / 6) * 2 * Math.PI) * 1.0;
    data[i] = data[i]! + 0.005 * Math.sin(i);
  }
  h.push(0, data, n);

  it('finds the first activation after a time and the cycle length', () => {
    const a = firstActivation(h, 0, 50, 400);
    expect(a).toBeGreaterThan(340);
    expect(a).toBeLessThan(346);
    expect(activations(h, 0, 0, 2000).length).toBe(7);
    expect(cycleLengthOf(h, 0, 0, 2000)).toBeCloseTo(300, 0);
  });

  it('ignores noise below the local-activation amplitude', () => {
    const q = new SignalHistory(1, fs, 1);
    q.push(0, Float32Array.from({ length: 1000 }, (_, i) => 0.01 * Math.sin(i)), 1000);
    expect(Number.isNaN(firstActivation(q, 0, 0, 500))).toBe(true);
  });
});
