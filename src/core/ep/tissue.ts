import { ValueNoise3 } from '../noise';
import { Region, PV_REGIONS } from '../mesh/regions';
import type { SurfaceMesh } from '../mesh/types';
import { buildGeometry, type TissueGeometry } from './fem';
import type { IonicSpec } from './ionic';
import { Substrate, type FibrosisPattern } from './substrate';
import { verticesNear } from './stimulus';

/**
 * Tissue presets and builders tying anatomy to electrophysiology (MODEL.md §2.3, §2.5).
 */
export type PresetId = 'healthy' | 'paroxysmal' | 'persistent';

export interface TissuePreset {
  id: PresetId;
  name: string;
  description: string;
  /** Healthy-tissue plane-wave conduction velocity target, m/s. */
  targetCv: number;
  ionic: IonicSpec;
  fibrosis: {
    /** Mean fibrosis density before regional weighting (0..1). */
    density: number;
    pattern: FibrosisPattern;
  };
}

export const PRESETS: Record<PresetId, TissuePreset> = {
  healthy: {
    id: 'healthy',
    name: 'Healthy atrium',
    description: 'Normal CV (0.75 m/s), APD90 ≈ 250 ms, no fibrosis. Rotors cannot sustain; macro-reentry around a large obstacle (≈10 cm circuit, e.g. the mitral annulus) still can.',
    targetCv: 0.75,
    ionic: { id: 'ms', params: { tauClose: 130, tauOpen: 120 } },
    fibrosis: { density: 0, pattern: 'patchy' },
  },
  paroxysmal: {
    id: 'paroxysmal',
    name: 'Paroxysmal AF substrate',
    description: 'Mildly shortened APD (≈ 190 ms), CV 0.7 m/s, sparse patchy fibrosis (≈ 5 %).',
    targetCv: 0.7,
    ionic: { id: 'ms', params: { tauClose: 95, tauOpen: 110 } },
    fibrosis: { density: 0.05, pattern: 'patchy' },
  },
  persistent: {
    id: 'persistent',
    name: 'Persistent AF substrate',
    description: 'Electrical remodeling: APD90 ≈ 120 ms, CV 0.5 m/s, patchy fibrosis (≈ 20 %, posterior/roof weighted). Wavelength ≈ 6 cm, short enough for functional reentry.',
    targetCv: 0.5,
    ionic: { id: 'ms', params: { tauClose: 55, tauOpen: 90 } },
    fibrosis: { density: 0.2, pattern: 'patchy' },
  },
};

/**
 * Relative fibrosis propensity by region (multiplies the preset density). The posterior wall and
 * antra are weighted up; the weights are an educational choice, not fitted to imaging data.
 */
export const FIBROSIS_REGION_WEIGHT: Partial<Record<Region, number>> = {
  [Region.Posterior]: 1.8,
  [Region.Roof]: 1.3,
  [Region.Inferior]: 1.0,
  [Region.LSPVAntrum]: 1.3,
  [Region.LIPVAntrum]: 1.3,
  [Region.RSPVAntrum]: 1.3,
  [Region.RIPVAntrum]: 1.3,
  [Region.Septum]: 0.8,
  [Region.Lateral]: 0.8,
  [Region.Anterior]: 0.6,
  [Region.LAA]: 0.5,
  [Region.MitralIsthmus]: 0.8,
  [Region.MitralAnnulus]: 0.6,
  [Region.LSPV]: 0.4,
  [Region.LIPV]: 0.4,
  [Region.RSPV]: 0.4,
  [Region.RIPV]: 0.4,
};

/** Smooth per-vertex fibrosis density field: regional weights × low-frequency noise, mean ≈ density. */
export function fibrosisDensityField(mesh: SurfaceMesh, density: number, seed: number): Float32Array {
  const n = mesh.region.length;
  const out = new Float32Array(n);
  if (density <= 0) return out;
  const noise = new ValueNoise3(seed ^ 0x51f0);
  const P = mesh.positions;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = FIBROSIS_REGION_WEIGHT[mesh.region[i] as Region] ?? 1;
    const nz = 0.5 + noise.fbm(P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!, 20, 2);
    out[i] = w * nz;
    sum += out[i]!;
  }
  const k = (density * n) / sum;
  for (let i = 0; i < n; i++) out[i] = Math.min(0.9, out[i]! * k);
  return out;
}

/**
 * Simplified fibre direction field (unit tangent per vertex): circumferential around each PV
 * near the veins, otherwise horizontal-circumferential (tangent ⟂ superior axis). This is a
 * coarse stand-in for histological fibre architecture (Ho 1999) used only by the interstitial
 * fibrosis pattern; conduction itself is isotropic in this version.
 */
export function fiberField(mesh: SurfaceMesh): Float32Array {
  const n = mesh.region.length;
  const out = new Float32Array(3 * n);
  const P = mesh.positions, N = mesh.normals;
  const pvs = mesh.anatomy?.pvs ?? [];
  for (let i = 0; i < n; i++) {
    let ax: [number, number, number] = [0, 0, 1];
    const p: [number, number, number] = [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!];
    for (const pv of pvs) {
      const d = Math.hypot(p[0] - pv.ostiumCenter[0], p[1] - pv.ostiumCenter[1], p[2] - pv.ostiumCenter[2]);
      if (d < pv.ostiumRadius + 12) { ax = pv.axis; break; }
    }
    const nx = N[3 * i]!, ny = N[3 * i + 1]!, nz = N[3 * i + 2]!;
    let fx = ax[1] * nz - ax[2] * ny, fy = ax[2] * nx - ax[0] * nz, fz = ax[0] * ny - ax[1] * nx;
    let l = Math.hypot(fx, fy, fz);
    if (l < 1e-3) { fx = 1; fy = 0; fz = 0; l = 1; }
    out[3 * i] = fx / l; out[3 * i + 1] = fy / l; out[3 * i + 2] = fz / l;
  }
  return out;
}

export interface TissueBuild {
  geom: TissueGeometry;
  substrate: Substrate;
  preset: TissuePreset;
}

export function buildTissue(mesh: SurfaceMesh, preset: TissuePreset, seed: number, fibrosisScale = 1, opts: { cristaBlock?: boolean } = {}): TissueBuild {
  const geom = buildGeometry(mesh.positions, mesh.indices);
  const density = fibrosisDensityField(mesh, preset.fibrosis.density * fibrosisScale, seed);
  const substrate = new Substrate(geom, {
    seed,
    fibrosisDensity: density,
    fibrosisPattern: preset.fibrosis.pattern,
    fiberDir: preset.fibrosis.pattern === 'interstitial' ? fiberField(mesh) : undefined,
  });
  if (mesh.chamber === 'RA' && (opts.cristaBlock ?? true)) applyCristaBlock(mesh, geom, substrate);
  return { geom, substrate, preset };
}

/**
 * Crista terminalis as a line of transverse conduction block (MODEL.md §8.2). Edges joining the
 * crista band to its anterior (trabeculated, tricuspid-facing) side are uncoupled; the band stays
 * coupled to the posterior venous sinus and along its own length. Returns the number of edges cut.
 */
export function applyCristaBlock(mesh: SurfaceMesh, geom: TissueGeometry, sub: Substrate): number {
  const tv = mesh.anatomy?.mitral.center;
  if (!tv) return 0;
  const P = mesh.positions;
  const band = (v: number) => mesh.region[v] === Region.CristaTerminalis;
  const dTv = (v: number) => Math.hypot(P[3 * v]! - tv[0], P[3 * v + 1]! - tv[1], P[3 * v + 2]! - tv[2]);
  let cut = 0;
  for (let e = 0; e < geom.edgeA.length; e++) {
    const a = geom.edgeA[e]!, b = geom.edgeB[e]!;
    if (band(a) === band(b)) continue;
    const inside = band(a) ? a : b, other = band(a) ? b : a;
    const r = mesh.region[other];
    if (r === Region.SVC || r === Region.IVC) continue;
    if (dTv(other) < dTv(inside)) { sub.edgeScale[e] = 0; cut++; }
  }
  return cut;
}

export interface SinusSite {
  name: string;
  vertices: Uint32Array;
  /** Delay after the sinus beat onset, ms. */
  delay: number;
}

/**
 * Left-atrial breakthrough sites in sinus rhythm (MODEL.md §2.5): Bachmann's bundle at the
 * anterosuperior septal roof (first), then the fossa-ovalis region of the mid septum, then the
 * coronary-sinus musculature at the inferior septum near the annulus. The right atrium is not
 * modelled, so these sites are driven directly.
 */
export function sinusSites(mesh: SurfaceMesh, radius = 4): SinusSite[] {
  // Right atrium (MODEL.md §8.2): one site, the sinus node at the superior crista terminalis.
  const ra = mesh.anatomy?.ra;
  if (mesh.chamber === 'RA' && ra) {
    const v = ra.sinusNode, P0 = mesh.positions;
    return [{ name: 'Sinus node', delay: 0, vertices: verticesNear(P0, [P0[3 * v]!, P0[3 * v + 1]!, P0[3 * v + 2]!], radius) }];
  }
  const n = mesh.region.length;
  const P = mesh.positions;
  const exclude = new Set<number>([...PV_REGIONS, Region.LAA]);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (exclude.has(mesh.region[i]!)) continue;
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, P[3 * i + c]!);
      max[c] = Math.max(max[c]!, P[3 * i + c]!);
    }
  }
  const q = (i: number, c: number) => (2 * (P[3 * i + c]! - min[c]!)) / (max[c]! - min[c]!) - 1;
  const best = (dir: [number, number, number], allowed: Region[]) => {
    let bi = -1, bs = -Infinity;
    const allow = new Set<number>(allowed);
    for (let i = 0; i < n; i++) {
      if (!allow.has(mesh.region[i]!)) continue;
      const s = dir[0] * q(i, 0) + dir[1] * q(i, 1) + dir[2] * q(i, 2);
      if (s > bs) { bs = s; bi = i; }
    }
    return bi;
  };
  const sites: Array<[string, number, number]> = [
    ['Bachmann bundle', best([-0.55, -0.55, 0.65], [Region.Septum, Region.Roof, Region.Anterior]), 0],
    ['Fossa ovalis', best([-1, 0.15, -0.1], [Region.Septum]), 15],
    ['Coronary sinus', best([-0.55, -0.15, -0.85], [Region.Septum, Region.Inferior, Region.MitralAnnulus]), 30],
  ];
  return sites
    .filter(([, v]) => v >= 0)
    .map(([name, v, delay]) => ({ name, delay, vertices: verticesNear(P, [P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!], radius) }));
}
