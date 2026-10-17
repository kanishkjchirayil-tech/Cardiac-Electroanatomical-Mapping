/**
 * Seeded pseudo-random numbers. All stochastic content (anatomy variation, substrate,
 * noise, scenarios) must draw from an Rng created from an explicit seed so that cases
 * and exported datasets are reproducible.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = hashSeed(seed);
  }

  /** mulberry32: uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiExclusive: number): number {
    return lo + Math.floor(this.next() * (hiExclusive - lo));
  }

  /** Standard normal via Box–Muller. */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Derive an independent child stream (e.g. one per subsystem). */
  fork(tag: number): Rng {
    return new Rng((this.s ^ Math.imul(tag + 1, 0x9e3779b1)) >>> 0);
  }
}

/** splitmix32-style integer hash used to decorrelate nearby seeds. */
export function hashSeed(seed: number): number {
  let z = (seed | 0) + 0x9e3779b9;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}
