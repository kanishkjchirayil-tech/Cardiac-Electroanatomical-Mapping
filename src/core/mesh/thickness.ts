import { ValueNoise3 } from '../noise';
import { REGIONS, Region } from './regions';
import type { Adjacency } from './topology';

export interface ThicknessOptions {
  /** Per-region overrides of the default wall thickness (mm). */
  perRegion: Partial<Record<Region, number>>;
  /** Global multiplier applied after per-region values. */
  scale: number;
  /** Relative amplitude of smooth random variation (0 = none). */
  jitter: number;
  /** Spatial scale of the variation, mm. */
  jitterScale: number;
  /** Jacobi smoothing passes over the vertex graph to blend region boundaries. */
  smoothingIterations: number;
  /** PV sleeves thin distally: thickness × max(sleeveMinFactor, 1 − depth / sleeveTaperLength). */
  sleeveTaperLength: number;
  sleeveMinFactor: number;
  min: number;
  max: number;
}

export const DEFAULT_THICKNESS: ThicknessOptions = {
  perRegion: {},
  scale: 1,
  jitter: 0.12,
  jitterScale: 15,
  smoothingIterations: 8,
  sleeveTaperLength: 25,
  sleeveMinFactor: 0.6,
  min: 0.5,
  max: 4,
};

/** Per-vertex wall thickness (mm). See MODEL.md §1.4. */
export function assignWallThickness(
  positions: Float32Array,
  adj: Adjacency,
  region: Uint8Array,
  veinDepth: Float32Array,
  seed: number,
  options: Partial<ThicknessOptions> = {},
): Float32Array {
  const o = { ...DEFAULT_THICKNESS, ...options };
  const nV = region.length;
  let th = new Float32Array(nV);
  for (let v = 0; v < nV; v++) {
    const r = region[v]! as Region;
    th[v] = o.perRegion[r] ?? REGIONS[r]?.thickness ?? REGIONS[0]!.thickness;
  }
  for (let it = 0; it < o.smoothingIterations; it++) {
    const next = new Float32Array(nV);
    for (let v = 0; v < nV; v++) {
      let s = th[v]!, n = 1;
      for (let j = adj.offsets[v]!; j < adj.offsets[v + 1]!; j++) {
        s += th[adj.neighbors[j]!]!;
        n++;
      }
      next[v] = s / n;
    }
    th = next;
  }
  const noise = new ValueNoise3(seed ^ 0x7417);
  for (let v = 0; v < nV; v++) {
    let t = th[v]! * o.scale;
    if (veinDepth[v]! > 0) t *= Math.max(o.sleeveMinFactor, 1 - veinDepth[v]! / o.sleeveTaperLength);
    if (o.jitter > 0) {
      const n = noise.fbm(positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!, o.jitterScale);
      t *= 1 + o.jitter * (2 * n - 1);
    }
    th[v] = Math.min(o.max, Math.max(o.min, t));
  }
  return th;
}
