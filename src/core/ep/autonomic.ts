import type { SurfaceMesh } from '../mesh/types';
import { Region, type PvName } from '../mesh/regions';
import { vertexAdjacency } from '../mesh/topology';
import { edgeDijkstra } from '../mesh/geodesic';
import { Rng } from '../rng';
import type { Vec3 } from '../math/vec3';

/**
 * Autonomic module (MODEL.md §7.1). PHENOMENOLOGICAL: no neurotransmitter kinetics, receptors or
 * ion-channel modulation are modelled; tone acts through a few documented scaling rules.
 *
 *  - Vagal tone v ∈ [0, 1] shortens APD/ERP (acetylcholine-activated K⁺ current). Uniform mode:
 *    APD × (1 − 0.25·v). Heterogeneous mode: APD × (1 − v·(0.12 + 0.40·W_i)), where W_i ∈ [0, 1] is
 *    the local density of ganglionated-plexus (GP) innervation, so refractoriness becomes uneven
 *    around the PV antra. APD is never scaled below 0.5×.
 *  - Vagal tone slows the sinus rate (CL × (1 + 0.5·v)); sympathetic tone s ∈ [0, 1] speeds it
 *    (CL / (1 + 0.6·s)).
 *  - Sympathetic tone raises the rate and probability of PV-sleeve ectopy: each vein has a latent
 *    focus that is "armed" when a seeded draw u_v < s, and armed foci fire 1–3-beat bursts as a
 *    Poisson process of rate 0.08·s per second per vein. Scenario triggers fire more often
 *    (interval / (1 + 2s)) and in longer runs (+ round(3s) beats).
 *  - Ablation inside a GP zone reduces that GP's contribution: efficacy = 1 − min(1, 1.5 × the
 *    GP-weighted fraction of its zone covered by lesions (core or border)).
 */
export interface AutonomicSettings {
  vagal: number;
  sympathetic: number;
  /** Uneven vagal effect concentrated in GP zones (otherwise uniform). */
  heterogeneous: boolean;
}

export const DEFAULT_AUTONOMIC: AutonomicSettings = { vagal: 0, sympathetic: 0, heterogeneous: true };

export const AUTONOMIC = {
  uniformApd: 0.25,
  baseApd: 0.12,
  gpApd: 0.4,
  minApdScale: 0.5,
  vagalCl: 0.5,
  sympatheticCl: 0.6,
  latentRate: 0.08,
  triggerIntervalGain: 2,
  triggerExtraBeats: 3,
  ablationGain: 1.5,
};

export interface GpZone {
  name: string;
  /** Vein the plexus lies next to. */
  pv: PvName;
  centre: number;
  radius: number;
  strength: number;
  /** Sparse weights: vertex indices and Gaussian weights (0..1, before strength). */
  idx: Uint32Array;
  w: Float32Array;
}

/**
 * The four major left-atrial ganglionated plexi (Armour 1997): superior left (above the LSPV
 * antrum), inferior left (below the LIPV), anterior right (in front of the RSPV) and inferior right
 * (below the RIPV). Each centre is the antral vertex 6–12 mm outside its vein's ostium furthest in
 * the plexus direction (seeded jitter); weights fall off as a Gaussian of Euclidean distance.
 */
export function buildGpZones(mesh: SurfaceMesh, seed = 1): GpZone[] {
  const rng = new Rng(seed ^ 0x6b0);
  const P = mesh.positions;
  const adj = vertexAdjacency(mesh.indices, mesh.region.length);
  const sleeves = new Set<number>([Region.LSPV, Region.LIPV, Region.RSPV, Region.RIPV]);
  const specs: Array<[string, PvName, Vec3]> = [
    ['Superior left GP', 'LSPV', [0, 0, 1]],
    ['Inferior left GP', 'LIPV', [0, 0.3, -1]],
    ['Anterior right GP', 'RSPV', [0, -1, 0.2]],
    ['Inferior right GP', 'RIPV', [0, 0.3, -1]],
  ];
  const out: GpZone[] = [];
  for (const [name, pv, dir0] of specs) {
    const lm = mesh.anatomy?.pvs.find((p) => p.name === pv);
    if (!lm) continue;
    const dir: Vec3 = [dir0[0] + rng.uniform(-0.25, 0.25), dir0[1] + rng.uniform(-0.25, 0.25), dir0[2] + rng.uniform(-0.25, 0.25)];
    const d = edgeDijkstra(P, adj, lm.ostiumRing, 14).distance;
    let best = -1, bs = -Infinity;
    for (let i = 0; i < d.length; i++) {
      if (d[i]! < 6 || d[i]! > 12 || sleeves.has(mesh.region[i]!)) continue;
      const s = dir[0] * (P[3 * i]! - lm.ostiumCenter[0]) + dir[1] * (P[3 * i + 1]! - lm.ostiumCenter[1]) + dir[2] * (P[3 * i + 2]! - lm.ostiumCenter[2]);
      if (s > bs) { bs = s; best = i; }
    }
    if (best < 0) continue;
    const radius = rng.uniform(5, 8);
    const idx: number[] = [], w: number[] = [];
    const cx = P[3 * best]!, cy = P[3 * best + 1]!, cz = P[3 * best + 2]!;
    for (let i = 0; i < mesh.region.length; i++) {
      const r2 = (P[3 * i]! - cx) ** 2 + (P[3 * i + 1]! - cy) ** 2 + (P[3 * i + 2]! - cz) ** 2;
      if (r2 > 9 * radius * radius) continue;
      idx.push(i);
      w.push(Math.exp(-r2 / (2 * radius * radius)));
    }
    out.push({ name, pv, centre: best, radius, strength: rng.uniform(0.7, 1.3), idx: Uint32Array.from(idx), w: Float32Array.from(w) });
  }
  return out;
}

/** Remaining efficacy of each GP (1 = intact) given the lesion raster (0 none, 1 border/partial, 2 core). */
export function gpEfficacy(zones: GpZone[], lesionKind: Uint8Array | null): number[] {
  return zones.map((z) => {
    if (!lesionKind) return 1;
    let hit = 0, tot = 0;
    for (let k = 0; k < z.idx.length; k++) {
      tot += z.w[k]!;
      if (lesionKind[z.idx[k]!]) hit += z.w[k]!;
    }
    return 1 - Math.min(1, AUTONOMIC.ablationGain * (tot > 0 ? hit / tot : 0));
  });
}

/** Per-vertex GP innervation density W_i ∈ [0, 1] (strength × efficacy × Gaussian weight, max over GPs). */
export function gpDensity(zones: GpZone[], nV: number, efficacy: number[] = zones.map(() => 1)): Float32Array {
  const out = new Float32Array(nV);
  zones.forEach((z, g) => {
    const s = z.strength * efficacy[g]!;
    for (let k = 0; k < z.idx.length; k++) {
      const v = z.idx[k]!;
      out[v] = Math.max(out[v]!, Math.min(1, s * z.w[k]!));
    }
  });
  return out;
}

/** Index of the GP zone each vertex belongs to (weight ≥ 0.3), or −1. */
export function gpZoneIndex(zones: GpZone[], nV: number): Int8Array {
  const out = new Int8Array(nV).fill(-1);
  const best = new Float32Array(nV);
  zones.forEach((z, g) => {
    for (let k = 0; k < z.idx.length; k++) {
      const v = z.idx[k]!;
      if (z.w[k]! >= 0.3 && z.w[k]! > best[v]!) { best[v] = z.w[k]!; out[v] = g; }
    }
  });
  return out;
}

/** APD scale with autonomic tone applied to a base (substrate) APD scale. */
export function autonomicApdScale(base: Float32Array, zones: GpZone[], lesionKind: Uint8Array | null, s: AutonomicSettings): Float32Array {
  const out = new Float32Array(base.length);
  const v = Math.max(0, Math.min(1, s.vagal));
  if (v === 0) { out.set(base); return out; }
  const W = s.heterogeneous ? gpDensity(zones, base.length, gpEfficacy(zones, lesionKind)) : null;
  for (let i = 0; i < base.length; i++) {
    const f = W ? 1 - v * (AUTONOMIC.baseApd + AUTONOMIC.gpApd * W[i]!) : 1 - v * AUTONOMIC.uniformApd;
    out[i] = base[i]! * Math.max(AUTONOMIC.minApdScale, f);
  }
  return out;
}

/** Sinus cycle-length multiplier. */
export function sinusClFactor(s: AutonomicSettings): number {
  return (1 + AUTONOMIC.vagalCl * Math.max(0, s.vagal)) / (1 + AUTONOMIC.sympatheticCl * Math.max(0, s.sympathetic));
}
