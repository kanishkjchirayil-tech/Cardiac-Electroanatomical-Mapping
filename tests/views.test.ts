import { describe, expect, it } from 'vitest';
import { standardViews } from '../src/render/views';
import { cross, dot, type Vec3 } from '../src/core/math/vec3';

/** Screen-right direction for a camera looking along -dir with the given up vector. */
const screenRight = (dir: Vec3, up: Vec3): Vec3 => cross(up, dir);

describe('standard camera views (LPS frame)', () => {
  const v = Object.fromEntries(standardViews(30).map((x) => [x.name, x]));

  it('AP shows patient left on screen right; PA mirrors it', () => {
    expect(dot(screenRight(v.AP!.dir, v.AP!.up), [1, 0, 0])).toBeCloseTo(1);
    expect(dot(screenRight(v.PA!.dir, v.PA!.up), [1, 0, 0])).toBeCloseTo(-1);
  });

  it('LAO views from the patient left-anterior, RAO from right-anterior', () => {
    expect(v.LAO!.dir[0]).toBeGreaterThan(0);
    expect(v.LAO!.dir[1]).toBeLessThan(0);
    expect(v.RAO!.dir[0]).toBeLessThan(0);
    expect(v.RAO!.dir[1]).toBeLessThan(0);
    expect(Math.acos(-v.LAO!.dir[1]) * 180 / Math.PI).toBeCloseTo(30);
  });

  it('all views have orthonormal dir/up', () => {
    for (const x of Object.values(v)) {
      expect(dot(x.dir, x.dir)).toBeCloseTo(1);
      expect(dot(x.up, x.up)).toBeCloseTo(1);
      expect(dot(x.dir, x.up)).toBeCloseTo(0);
    }
  });
});
