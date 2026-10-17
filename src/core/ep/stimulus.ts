/**
 * Stimulus sites and schedules. A site is a set of vertices receiving a square current pulse
 * (normalized units: Δv/dt in 1/ms). Up to MAX_STIM_SITES sites are active in a simulation.
 */
export const MAX_STIM_SITES = 8;
export const DEFAULT_STIM_AMPLITUDE = 0.5;
export const DEFAULT_STIM_DURATION = 2;

export interface StimSite {
  name: string;
  vertices: Uint32Array;
  amplitude: number;
  duration: number;
}

export interface StimTrain {
  site: number;
  /** First pulse time (ms). */
  start: number;
  /** Pacing cycle length (ms); Infinity for a single pulse. */
  period: number;
  /** Number of pulses (Infinity = until removed). */
  count: number;
}

export class StimulusSchedule {
  sites: StimSite[] = [];
  trains: StimTrain[] = [];

  addSite(site: StimSite): number {
    if (this.sites.length >= MAX_STIM_SITES) throw new Error(`At most ${MAX_STIM_SITES} stimulus sites`);
    this.sites.push(site);
    return this.sites.length - 1;
  }

  /** Per-vertex site index (−1 = none) for the backend. */
  siteMap(nV: number): Int32Array {
    const map = new Int32Array(nV).fill(-1);
    this.sites.forEach((s, k) => s.vertices.forEach((v) => (map[v] = k)));
    return map;
  }

  /** Write the current amplitude of every site at time t into out[0..MAX_STIM_SITES). */
  amplitudes(t: number, out: Float32Array): void {
    out.fill(0);
    for (const tr of this.trains) {
      const site = this.sites[tr.site];
      if (!site || t < tr.start) continue;
      const k = Number.isFinite(tr.period) ? Math.floor((t - tr.start) / tr.period) : 0;
      if (k >= tr.count) continue;
      const pulseStart = tr.start + k * (Number.isFinite(tr.period) ? tr.period : 0);
      if (t >= pulseStart && t < pulseStart + site.duration) out[tr.site] = Math.max(out[tr.site]!, site.amplitude);
    }
  }

  /** Remove trains whose pulses have all finished before time t. */
  prune(t: number): void {
    this.trains = this.trains.filter((tr) => {
      const site = this.sites[tr.site];
      if (!site) return false;
      if (!Number.isFinite(tr.count)) return true;
      const last = tr.start + (tr.count - 1) * (Number.isFinite(tr.period) ? tr.period : 0);
      return t < last + site.duration;
    });
  }
}

/** Vertices within Euclidean radius r (mm) of point c; falls back to the nearest vertex. */
export function verticesNear(positions: Float32Array, c: [number, number, number], r: number): Uint32Array {
  const out: number[] = [];
  let best = 0, bestD = Infinity;
  for (let i = 0; i < positions.length / 3; i++) {
    const d = Math.hypot(positions[3 * i]! - c[0], positions[3 * i + 1]! - c[1], positions[3 * i + 2]! - c[2]);
    if (d <= r) out.push(i);
    if (d < bestD) { bestD = d; best = i; }
  }
  return Uint32Array.from(out.length ? out : [best]);
}
