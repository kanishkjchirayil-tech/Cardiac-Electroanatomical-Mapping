import type { SurfaceMesh } from '../core/mesh/types';
import { generateAtrium } from '../core/mesh/atrium';
import { SpatialGrid } from '../core/mesh/spatial';
import { MappingSession, type RecordedBeat } from '../core/mapping/session';
import { Rng } from '../core/rng';
import type { ScenarioId } from '../core/scenarios/scenarios';
import { pointRecords, DEFAULT_EGM_EXPORT, type EgmExportOptions, type PointRecord } from '../core/export/dataset';
import type { PresetId } from '../core/ep/tissue';
import type { CatheterType } from '../core/catheter/roving';
import { SimEngine } from './engine';
import { DEFAULT_SIM_CONFIG, type BackendPref, type FromWorker, type SimMode } from './protocol';

/**
 * Headless batch generation of seeded random cases (MODEL.md §7.3). Each case runs the normal
 * engine (no UI), places the roving catheter at random surface sites, and acquires points through
 * the same recording chain, filters and annotation as interactive mapping. Ground-truth labels are
 * attached per point from the engine's hidden state.
 */
export interface BatchSpec {
  cases: number;
  seed: number;
  /** Scenarios to draw from ('free' = random tissue preset and fibrosis, sinus rhythm). */
  scenarios: Array<ScenarioId | 'free'>;
  mode: SimMode;
  backend: BackendPref;
  pointsPerCase: number;
  catheter: CatheterType;
  /** 0 = use the given mesh for every case; > 0 = a new procedural anatomy per case. */
  anatomyVariability: number;
  /** Draw vagal and sympathetic tone uniformly in [0, 1] per case. */
  randomAutonomic: boolean;
  /** Simulated warm-up before mapping (lets arrhythmias start), ms. */
  warmupMs: number;
  /** Give up on a site after this much simulated time, ms. */
  maxDwellMs: number;
  egm: EgmExportOptions;
  includeMesh: boolean;
}

export const DEFAULT_BATCH: BatchSpec = {
  cases: 5,
  seed: 1,
  scenarios: ['free'],
  mode: 'eikonal',
  backend: 'auto',
  pointsPerCase: 60,
  catheter: 'ablation',
  anatomyVariability: 0,
  randomAutonomic: false,
  warmupMs: 1500,
  maxDwellMs: 3500,
  egm: DEFAULT_EGM_EXPORT,
  includeMesh: false,
};

export interface BatchCase {
  index: number;
  seed: number;
  scenario: ScenarioId | 'free';
  preset: PresetId | null;
  fibrosisScale: number | null;
  anatomy: { seed: number; variability: number } | null;
  autonomic: { vagal: number; sympathetic: number };
  sinusCl: number;
  truth: string | null;
  criticalLabel: string;
  attempts: number;
  points: PointRecord[];
  mesh?: { positions: number[]; indices: number[]; region: number[]; wallThickness: number[] };
}

export interface BatchDataset {
  format: 'ostium-batch/1';
  notice: string;
  spec: BatchSpec;
  cases: BatchCase[];
}

export interface BatchProgress {
  caseIndex: number;
  cases: number;
  points: number;
  pointsPerCase: number;
}

const PRESET_IDS: PresetId[] = ['healthy', 'paroxysmal', 'persistent'];

export async function runBatch(
  spec: BatchSpec,
  baseMesh: SurfaceMesh,
  onProgress: (p: BatchProgress) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<BatchDataset> {
  const rng = new Rng(spec.seed * 104729 + 17);
  const cases: BatchCase[] = [];
  for (let i = 0; i < spec.cases && !cancelled(); i++) {
    const cr = rng.fork(i);
    const seed = 1 + cr.int(0, 1_000_000);
    const scenario = spec.scenarios[cr.int(0, spec.scenarios.length)] ?? 'free';
    const anatomy = spec.anatomyVariability > 0 ? { seed: 1 + cr.int(0, 1_000_000), variability: spec.anatomyVariability } : null;
    const mesh = anatomy ? generateAtrium({ seed: anatomy.seed, variability: anatomy.variability }).mesh : baseMesh;
    const preset = scenario === 'free' ? PRESET_IDS[cr.int(0, PRESET_IDS.length)]! : null;
    const fibrosisScale = scenario === 'free' ? cr.uniform(0, 2) : null;
    const autonomic = spec.randomAutonomic ? { vagal: cr.next(), sympathetic: cr.next() } : { vagal: 0, sympathetic: 0 };
    const msgs: FromWorker[] = [];
    const engine = new SimEngine((m) => msgs.push(m));
    await engine.init(mesh, {
      ...DEFAULT_SIM_CONFIG,
      mode: spec.mode,
      backend: spec.backend,
      seed,
      preset: preset ?? DEFAULT_SIM_CONFIG.preset,
      fibrosisScale: fibrosisScale ?? 1,
      scenario: scenario === 'free' ? null : { id: scenario, seed },
    });
    const err = msgs.find((m) => m.type === 'error');
    if (err && err.type === 'error') throw new Error(`Case ${i}: ${err.message}`);
    await engine.setAutonomic({ ...autonomic, heterogeneous: true });
    await engine.setRovingConfig({ type: spec.catheter });
    msgs.length = 0;
    await engine.step(spec.warmupMs);
    const session = new MappingSession(new SpatialGrid(mesh.positions, 4));
    const boundary = new Set<number>(mesh.boundaryLoops.flatMap((l) => Array.from(l.vertices)));
    const sites = mesh.region.length;
    let attempts = 0;
    while (session.points.length < spec.pointsPerCase && attempts < spec.pointsPerCase * 3 && !cancelled()) {
      attempts++;
      let v = cr.int(0, sites);
      while (boundary.has(v)) v = cr.int(0, sites);
      await engine.placeRoving(v);
      msgs.length = 0;
      let got = false;
      for (let t = 0; t < spec.maxDwellMs && !got; t += 100) {
        await engine.step(100);
        for (const m of msgs) {
          if (m.type !== 'beat') continue;
          const beat = m.beat as unknown as RecordedBeat;
          session.observe(beat);
          if (session.acquire(beat, 'auto').length) got = true;
        }
        msgs.length = 0;
      }
      onProgress({ caseIndex: i, cases: spec.cases, points: Math.min(session.points.length, spec.pointsPerCase), pointsPerCase: spec.pointsPerCase });
    }
    const labels = engine.labels();
    await engine.requestReport();
    const report = msgs.find((m) => m.type === 'report');
    const out: BatchCase = {
      index: i,
      seed,
      scenario,
      preset,
      fibrosisScale,
      anatomy,
      autonomic,
      sinusCl: engine.effectiveSinusCl(),
      truth: report && report.type === 'report' ? report.report.truth?.summary ?? null : null,
      criticalLabel: labels?.criticalLabel ?? 'none',
      attempts,
      points: pointRecords(session.points.slice(0, spec.pointsPerCase), mesh, labels, spec.egm),
    };
    if (spec.includeMesh) out.mesh = { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices), region: Array.from(mesh.region), wallThickness: Array.from(mesh.wallThickness) };
    cases.push(out);
  }
  return { format: 'ostium-batch/1', notice: 'Educational simulation, not for clinical use. Fields under "gt" are hidden simulation ground truth.', spec, cases };
}
