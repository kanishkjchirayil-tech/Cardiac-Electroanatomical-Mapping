import { hexSheet } from '../mesh/primitives';
import { buildGeometry, type TissueGeometry } from './fem';
import { createIonicModel, type IonicSpec } from './ionic';
import { CpuBackend } from './solver-cpu';
import { Simulation } from './simulation';

/**
 * Tissue-lab measurements on a flat strip with the same lattice spacing as the atrial mesh
 * (MODEL.md §2.4): plane-wave conduction velocity, APD90, S1–S2 restitution and ERP, and
 * auto-calibration of the diffusivity D0 to a target conduction velocity.
 */
export interface LabOptions {
  /** Lattice edge length, mm (use the atrial mesh's mean edge). */
  h?: number;
  dt?: number;
  /** Strip length and width, mm. */
  length?: number;
  width?: number;
  /** Uniform APD scale for the strip. */
  apdScale?: number;
}

const DEFAULTS = { h: 0.955, dt: 0.05, length: 40, width: 5, apdScale: 1 };

interface Strip {
  geom: TissueGeometry;
  left: Uint32Array;
  /** Vertex groups near x = probe positions, used to average activation times. */
  near(x: number): number[];
}

const stripCache = new Map<string, Strip>();

function strip(o: Required<LabOptions>): Strip {
  const key = `${o.h}:${o.length}:${o.width}`;
  let s = stripCache.get(key);
  if (s) return s;
  const m = hexSheet(o.length, o.width, o.h);
  const geom = buildGeometry(m.positions, m.indices);
  const left: number[] = [];
  for (let i = 0; i < geom.nV; i++) if (geom.positions[3 * i]! < 1.5) left.push(i);
  s = {
    geom,
    left: Uint32Array.from(left),
    near: (x) => {
      const out: number[] = [];
      for (let i = 0; i < geom.nV; i++) if (Math.abs(geom.positions[3 * i]! - x) < o.h * 0.51) out.push(i);
      return out;
    },
  };
  stripCache.set(key, s);
  return s;
}

function makeSim(ionic: IonicSpec, D: number, o: Required<LabOptions>, s: Strip): { sim: Simulation; be: CpuBackend } {
  const n = s.geom.nV;
  const be = new CpuBackend({
    geom: s.geom,
    model: createIonicModel(ionic),
    edgeD: new Float32Array(s.geom.edgeA.length).fill(D),
    apdScale: new Float32Array(n).fill(o.apdScale),
    excitable: new Uint8Array(n).fill(1),
    siteOf: new Int32Array(n).fill(-1),
    dt: o.dt,
  });
  const sim = new Simulation(be, o.dt);
  sim.schedule.addSite({ name: 'S', vertices: s.left, amplitude: 0.5, duration: 2 });
  sim.markSitesChanged();
  return { sim, be };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

export interface ConductionResult {
  /** Plane-wave conduction velocity, m/s (= mm/ms); NaN if the wave did not propagate. */
  cv: number;
  /** APD at 90 % repolarization, ms. */
  apd90: number;
  propagated: boolean;
}

/** Single plane wave from rest: CV between x = L/4 and 3L/4, APD90 at the centre. */
export async function measureConduction(ionic: IonicSpec, D: number, opts: LabOptions = {}): Promise<ConductionResult> {
  const o = { ...DEFAULTS, ...opts };
  const s = strip(o);
  const { sim, be } = makeSim(ionic, D, o, s);
  sim.schedule.trains.push({ site: 0, start: 1, period: Infinity, count: 1 });
  await sim.advance(o.length * 8 + 500);
  const a = be.readActivation();
  const x1 = o.length / 4, x2 = (3 * o.length) / 4;
  const t1 = mean(s.near(x1).map((i) => a.last[i]!));
  const t2 = mean(s.near(x2).map((i) => a.last[i]!));
  const mid = s.near(o.length / 2);
  const apd90 = mean(mid.map((i) => a.repol[i]! - a.last[i]!));
  const propagated = Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1;
  return { cv: propagated ? (x2 - x1) / (t2 - t1) : NaN, apd90, propagated };
}

export interface CalibrationResult {
  D: number;
  cv: number;
  apd90: number;
  iterations: number;
}

/**
 * Find D0 (mm²/ms) giving plane-wave CV = target (m/s) on the discrete lattice. Uses the
 * near-square-root scaling CV ∝ √D: D ← D·(target/CV)², which converges in a few iterations.
 */
export async function calibrateDiffusivity(ionic: IonicSpec, targetCv: number, opts: LabOptions = {}, tol = 0.005): Promise<CalibrationResult> {
  let D = 0.3;
  let r = await measureConduction(ionic, D, opts);
  let it = 1;
  while (!r.propagated && it < 12) {
    D *= 2;
    r = await measureConduction(ionic, D, opts);
    it++;
  }
  for (; it < 20 && Math.abs(r.cv / targetCv - 1) > tol; it++) {
    D *= (targetCv / r.cv) ** 2;
    r = await measureConduction(ionic, D, opts);
  }
  return { D, cv: r.cv, apd90: r.apd90, iterations: it };
}

export interface RestitutionPoint {
  /** S1–S2 coupling interval, ms. */
  ci: number;
  /** Diastolic interval preceding the S2 beat at the strip centre, ms. */
  di: number;
  apd90: number;
  /** S2 conduction velocity, m/s. */
  cv: number;
  propagated: boolean;
}

export interface RestitutionResult {
  points: RestitutionPoint[];
  /** Effective refractory period: longest coupling interval that failed to propagate (ms), measured to ±step. */
  erp: number;
  s1: number;
}

/**
 * S1–S2 restitution: `nS1` beats at cycle length s1, then one S2 at decreasing coupling intervals
 * until S2 fails to propagate through the strip.
 */
export async function measureRestitution(
  ionic: IonicSpec,
  D: number,
  opts: LabOptions & { s1?: number; nS1?: number; ciMax?: number; step?: number } = {},
): Promise<RestitutionResult> {
  const o = { ...DEFAULTS, ...opts };
  const s1 = opts.s1 ?? 600, nS1 = opts.nS1 ?? 6, step = opts.step ?? 10;
  const s = strip(o);
  const { sim, be } = makeSim(ionic, D, o, s);
  sim.schedule.trains.push({ site: 0, start: 1, period: s1, count: nS1 });
  // Snapshot shortly after the last S1 pulse; every S2 run restarts from here.
  const tLastS1 = 1 + (nS1 - 1) * s1;
  const tSnap = tLastS1 + 5;
  await sim.advance(tSnap);
  const snapshot = be.getState();
  // Baseline run without S2 gives the repolarization time of the last S1 beat.
  be.resetActivation();
  await sim.advance(s1);
  const s1Repol = be.readActivation().repol;

  const x1 = o.length / 4, x2 = (3 * o.length) / 4;
  const p1 = s.near(x1), p2 = s.near(x2), mid = s.near(o.length / 2);
  const points: RestitutionPoint[] = [];
  let erp = NaN;
  const ciMax = opts.ciMax ?? Math.min(s1 - 50, 500);
  for (let ci = ciMax; ci >= 20; ci -= step) {
    be.setState(snapshot.v, snapshot.g0, snapshot.g1);
    be.resetActivation();
    sim.t = tSnap;
    sim.schedule.trains = [{ site: 0, start: tLastS1 + ci, period: Infinity, count: 1 }];
    await sim.advance(ci + o.length * 6 + 400);
    const a = be.readActivation();
    const s2Time = tLastS1 + ci;
    const t1 = mean(p1.map((i) => a.last[i]!)), t2 = mean(p2.map((i) => a.last[i]!));
    const propagated = mid.every((i) => a.last[i]! > s2Time) && p2.every((i) => a.last[i]! > s2Time);
    if (!propagated) {
      erp = ci;
      break;
    }
    // DI at the centre: S2 activation minus the repolarization of the preceding S1 beat.
    const tAct = mean(mid.map((i) => a.last[i]!));
    const prevRepol = mean(mid.map((i) => s1Repol[i]!));
    const apd = mean(mid.map((i) => a.repol[i]! - a.last[i]!));
    points.push({ ci, di: tAct - prevRepol, apd90: apd, cv: (x2 - x1) / (t2 - t1), propagated });
  }
  return { points, erp, s1 };
}
