import { hashSeed } from './rng';

/**
 * Seeded 3-D value noise (trilinear, smoothstep-faded) and fractal sum.
 * Used for low-frequency spatial variation (wall thickness, later fibrosis patterns).
 */
export class ValueNoise3 {
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = hashSeed(seed);
  }

  private lattice(i: number, j: number, k: number): number {
    let h = this.seed ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  /** Noise in [0, 1] at point (x, y, z) in lattice units. */
  sample(x: number, y: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const fx = x - i, fy = y - j, fz = z - k;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = l(this.lattice(i, j, k), this.lattice(i + 1, j, k), u);
    const c10 = l(this.lattice(i, j + 1, k), this.lattice(i + 1, j + 1, k), u);
    const c01 = l(this.lattice(i, j, k + 1), this.lattice(i + 1, j, k + 1), u);
    const c11 = l(this.lattice(i, j + 1, k + 1), this.lattice(i + 1, j + 1, k + 1), u);
    return l(l(c00, c10, v), l(c01, c11, v), w);
  }

  /** Fractal (fBm) noise in [0, 1]; `scale` is the feature size in world units. */
  fbm(x: number, y: number, z: number, scale: number, octaves = 3): number {
    let amp = 1, freq = 1 / scale, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq + 17.1 * o, y * freq - 5.3 * o, z * freq + 3.7 * o);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
