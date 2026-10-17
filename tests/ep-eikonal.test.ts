import { describe, expect, it } from 'vitest';
import { hexSheet } from '../src/core/mesh/primitives';
import { fastMarching } from '../src/core/ep/eikonal';

describe('fast marching eikonal solver', () => {
  const s = hexSheet(40, 40, 0.955);
  const n = s.positions.length / 3;
  const P = s.positions;
  const centre = (() => {
    let b = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(P[3 * i]! - 20, P[3 * i + 1]! - 20);
      if (d < bd) { bd = d; b = i; }
    }
    return b;
  })();

  it('point source on a flat sheet: T ≈ distance / F within 3 %', () => {
    const F = 0.7;
    const T = fastMarching(P, s.indices, new Float32Array(n).fill(F), [{ vertex: centre, t0: 0 }]);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(P[3 * i]! - P[3 * centre]!, P[3 * i + 1]! - P[3 * centre + 1]!);
      if (d < 5) continue;
      worst = Math.max(worst, Math.abs((T[i]! * F) / d - 1));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('routes around a line of block and respects source delays', () => {
    const speed = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) if (Math.abs(P[3 * i]! - 25) < 0.6 && P[3 * i + 1]! < 30) speed[i] = 0;
    const T = fastMarching(P, s.indices, speed, [{ vertex: centre, t0: 5 }]);
    expect(T[centre]).toBe(5);
    // Points behind the wall are reached only around its end (y ≥ 30).
    for (let i = 0; i < n; i++) {
      if (P[3 * i]! > 27 && P[3 * i + 1]! < 15 && P[3 * i + 1]! > 10) {
        const direct = Math.hypot(P[3 * i]! - 20, P[3 * i + 1]! - 20);
        expect(T[i]! - 5).toBeGreaterThan(direct * 1.5);
      }
      if (speed[i] === 0) expect(T[i]).toBe(Infinity);
    }
  });
});
