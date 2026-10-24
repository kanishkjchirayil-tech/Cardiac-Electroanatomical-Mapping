import { describe, expect, it } from 'vitest';
import { SCENARIO_IDS, buildScenario, scenarioInfo, type ScenarioId } from '../src/core/scenarios/scenarios';
import { MeshTools } from '../src/core/scenarios/geometry';
import { buildTissue, sinusSites } from '../src/core/ep/tissue';
import { AblationController, DEFAULT_ABLATION, applyLesionsToSubstrate } from '../src/core/ablation/controller';
import { antralRing } from '../src/core/ablation/rings';
import { buildEsophagus } from '../src/core/ablation/esophagus';
import { caseGroundTruth } from '../src/engine/case';
import { evaluateCase, type MapSummary } from '../src/core/scenarios/report';
import { Region, PV_NAMES, type PvName } from '../src/core/mesh/regions';
import { getV, type Vec3 } from '../src/core/math/vec3';
import type { CaseGroundTruth } from '../src/engine/protocol';
import { defaultAtrium } from './helpers';

/** Ground truth for a scenario after the given extra lesions (no solver needed). */
function truthAfter(id: ScenarioId, seed: number, extra: number[] = [], power = 35, duration = 20) {
  const { mesh } = defaultAtrium();
  const sc = buildScenario(mesh, id, seed);
  const tissue = buildTissue(mesh, sc.preset, sc.seed, sc.fibrosisScale);
  const eso = buildEsophagus(mesh, seed);
  const ctl = new AblationController(mesh, eso.zone);
  for (const pl of sc.priorLesions) ctl.deliver(pl.vertex, getV(mesh.positions, pl.vertex), { ...DEFAULT_ABLATION, power: pl.power, duration: pl.duration }, pl.force, 0).prior = true;
  for (const v of extra) ctl.deliver(v, getV(mesh.positions, v), { ...DEFAULT_ABLATION, power, duration }, 15, 100);
  applyLesionsToSubstrate(tissue.substrate, ctl.rasterize(200));
  const gt = caseGroundTruth(
    { mesh, substrate: tissue.substrate, geom: tissue.geom, D0: 0.5, sinusSites: sinusSites(mesh), ablation: ctl, esophagealZone: eso.zone },
    sc, 200, 0, { rhythm: 'sinus', inductions: 0, cardioversions: 0, pacingLog: [], sources: sc.sources },
  );
  return { mesh, sc, gt, ctl };
}

/** Lesion centres every ~4 mm along a path. */
function along(tools: MeshTools, path: number[], spacing = 4): number[] {
  const out = [path[0]!];
  let acc = 0;
  for (let k = 1; k < path.length; k++) {
    acc += tools.distance(path[k - 1]!, path[k]!);
    if (acc >= spacing) { out.push(path[k]!); acc = 0; }
  }
  if (out[out.length - 1] !== path[path.length - 1]) out.push(path[path.length - 1]!);
  return out;
}

describe('scenario ground truth', () => {
  it('every scenario builds deterministically from its seed and varies between seeds', () => {
    const { mesh } = defaultAtrium();
    for (const id of SCENARIO_IDS.filter((x) => scenarioInfo(x).chamber === 'LA')) {
      const a = buildScenario(mesh, id, 3), b = buildScenario(mesh, id, 3);
      expect(a.truth).toEqual(b.truth);
      expect(a.sinusCl).toBe(b.sinusCl);
      expect(a.info.criteria.length).toBeGreaterThan(1);
      const summaries = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(buildScenario(mesh, id, s).truth) + buildScenario(mesh, id, s).sinusCl));
      expect(summaries.size).toBeGreaterThan(1);
    }
  });

  it('PV triggers sit in vein sleeves; the focal AT focus is a real site', () => {
    const { mesh } = defaultAtrium();
    for (let seed = 1; seed <= 5; seed++) {
      const paf = buildScenario(mesh, 'paf', seed);
      for (const s of paf.sources) expect(mesh.region[s.centre]).toBe(Region[s.pv!]);
      const focal = buildScenario(mesh, 'focal', seed);
      expect(focal.sources).toHaveLength(1);
      expect(focal.truth.focusVertex).toBe(focal.sources[0]!.centre);
      expect(focal.sources[0]!.mode).toBe('automatic');
    }
  });

  it('redo: exactly the gap vein is reconnected, and a lesion in the gap re-isolates it', () => {
    for (const seed of [1, 2]) {
      const { gt, sc } = truthAfter('redo', seed);
      const connected = gt.pv.filter((p) => !p.durable).map((p) => p.pv);
      expect(connected).toEqual([sc.truth.gapPv]);
      // One lesion is not enough for a two-lesion gap; both missing sites close it.
      const one = truthAfter('redo', seed, [sc.truth.gapVertices![0]!]);
      expect(one.gt.pv.find((p) => p.pv === sc.truth.gapPv)!.durable).toBe(false);
      const fixed = truthAfter('redo', seed, sc.truth.gapVertices!);
      expect(fixed.gt.pv.every((p) => p.durable)).toBe(true);
      expect(fixed.gt.gapClosed).toBe(true);
    }
  });

  it('post-PVI flutter cases: rings isolate every vein; a mitral line and a roof line create their blocks', () => {
    const base = truthAfter('pmf', 1);
    expect(base.gt.pv.every((p) => p.durable)).toBe(true);
    expect(base.gt.mitralBlock.durable).toBe(false);
    expect(base.gt.roofBlock.durable).toBe(false);
    const tools = new MeshTools(base.mesh);
    const P = base.mesh.positions;
    const left = antralRing(base.mesh, ['LSPV', 'LIPV'], 7, 4), right = antralRing(base.mesh, ['RSPV', 'RIPV'], 7, 4);
    // The mitral isthmus is thick (≈ 2.5 mm): deep lesions at 3 mm spacing close it.
    const mi = along(tools, tools.path(tools.loop('MV'), left), 3);
    const withMi = truthAfter('pmf', 1, mi, 45, 30);
    expect(withMi.gt.mitralBlock.durable).toBe(true);
    expect(withMi.gt.roofBlock.durable).toBe(false);
    const roof = along(tools, tools.path(left.filter((v) => P[3 * v + 2]! > 10), right.filter((v) => P[3 * v + 2]! > 10)));
    const withRoof = truthAfter('roof', 1, roof);
    expect(withRoof.gt.roofBlock.durable).toBe(true);
    expect(withRoof.gt.mitralBlock.durable).toBe(false);
    // A line with three missing lesions (≈ 12 mm) leaves a gap.
    const mid = Math.floor(mi.length / 2);
    const gapped = truthAfter('pmf', 1, mi.filter((_, k) => Math.abs(k - mid) > 1), 45, 30);
    expect(gapped.gt.mitralBlock.durable).toBe(false);
  });
});

describe('case evaluation', () => {
  const { mesh } = defaultAtrium();
  const pvCentre = Object.fromEntries(PV_NAMES.map((pv) => [pv, mesh.anatomy!.pvs.find((p) => p.name === pv)!.ostiumCenter])) as Record<PvName, Vec3>;
  const sleeveVertex = (pv: PvName) => mesh.region.findIndex((r) => r === Region[pv]);
  const map = (points: MapSummary['points'] = [], coverage = 0.9): MapSummary => ({ points, coverage, earliest: null, areaCm2: 100 });

  it('PAF needs isolation plus entrance and exit block evidence in every vein', () => {
    const { gt: isolated, ctl } = truthAfter('paf', 1, PV_NAMES.flatMap((pv) => antralRing(mesh, pv, 5, 4)));
    expect(isolated.pv.every((p) => p.durable)).toBe(true);
    const t = 1000;
    const silent = PV_NAMES.map((pv) => ({ time: t, vertex: sleeveVertex(pv), position: [0, 0, 0] as Vec3, region: Region[pv], lat: NaN, bipolar: 0.03, excluded: false }));
    const exitLog = PV_NAMES.map((pv) => ({ active: false, site: 'roving' as const, output: 10, protocol: { kind: 'fixed' as const, cl: 500, count: 6 }, t0: t, end: t + 3000, stims: 6, localCapture: true, csFollows: false, intervals: [], entrain: null, rovingVertex: sleeveVertex(pv), rovingRegion: Region[pv], captureTruth: 1 }));
    const noEvidence = evaluateCase(isolated, map(), ctl.lesions, pvCentre);
    expect(noEvidence.criteria.map((c) => c.passed)).toEqual([true, false, false]);
    expect(noEvidence.success).toBe(false);
    const full = evaluateCase({ ...isolated, pacingLog: exitLog } as CaseGroundTruth, map(silent), ctl.lesions, pvCentre);
    expect(full.success).toBe(true);
    // Evidence collected before the last lesion near a vein does not count.
    const early = evaluateCase({ ...isolated, pacingLog: exitLog.map((e) => ({ ...e, end: 50 })) } as CaseGroundTruth, map(silent.map((p) => ({ ...p, time: 50 }))), ctl.lesions, pvCentre);
    expect(early.criteria[1]!.passed).toBe(false);
    expect(early.criteria[2]!.passed).toBe(false);
  });

  it('safety warnings and lesion statistics', () => {
    const { gt, ctl } = truthAfter('sinus', 1, [sleeveVertex('LSPV')]);
    const ev = evaluateCase({ ...gt, safety: { ...gt.safety, esophagealWarnings: 1, maxEsophagealTemp: 40.2 } }, map(), ctl.lesions, pvCentre);
    expect(ev.lesions.user).toBe(1);
    expect(ev.safety.warnings.some((w) => w.includes('esophageal'))).toBe(true);
    expect(ev.criteria[0]!.passed).toBe(true); // coverage 90 %
    expect(ev.criteria[1]!.passed).toBe(false); // no LAT map
  });
});
