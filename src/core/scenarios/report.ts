import type { Vec3 } from '../math/vec3';
import { Region, PV_NAMES, type PvName } from '../mesh/regions';
import type { CaseGroundTruth, PacingLogEntry } from '../../engine/protocol';
import { lesionGaps, type Lesion } from '../ablation/lesion';

/**
 * End-of-case evaluation (MODEL.md §6.3): combines the hidden-state ground truth from the engine
 * with evidence of what the learner did and saw (mapping points, pacing manoeuvres), and scores
 * the scenario's explicit success criteria.
 */
export interface MapSummary {
  points: Array<{ time: number; vertex: number; position: Vec3; region: number; lat: number; bipolar: number; excluded: boolean }>;
  /** Fraction of the surface within the fill threshold of an included point. */
  coverage: number;
  /** Location of the earliest interpolated LAT, if an LAT map exists. */
  earliest: Vec3 | null;
  areaCm2: number;
}

export interface Criterion {
  label: string;
  passed: boolean;
  detail: string;
}

export interface CaseEvaluation {
  criteria: Criterion[];
  success: boolean;
  map: { points: number; included: number; coverage: number; density: number };
  lesions: { user: number; prior: number; rfSeconds: number; meanLqi: number; belowTarget: number; gaps: number };
  procedure: { simSeconds: number; wallMinutes: number; inductions: number; cardioversions: number; pacingManoeuvres: number };
  safety: { warnings: string[] };
}

export const EVIDENCE = {
  /** Bipolar amplitude below which a point inside a vein counts as "no PV potential", mV. */
  silentPv: 0.1,
  /** Lesions within this distance of a vein's ostium count as that vein's lesion set, mm. */
  pvLesionRadius: 30,
  /** Line block shown by pacing: stimulus-to-electrogram ≥ this… */
  lineBlockMs: 100,
  /** …to a bipole no farther than this from the pacing cathode, mm. */
  lineBlockMm: 35,
  /** Or a paced activation map with at least this many points acquired during pacing. */
  pacedMapPoints: 10,
};

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export function evaluateCase(gt: CaseGroundTruth, map: MapSummary, lesions: Lesion[], pvCentre: Record<PvName, Vec3>, gapThreshold = 6): CaseEvaluation {
  const user = lesions.filter((l) => !l.prior);
  const lastNear = (c: Vec3) => user.filter((l) => dist(l.center, c) < EVIDENCE.pvLesionRadius).reduce((t, l) => Math.max(t, l.time), -Infinity);
  const lastLesion = user.reduce((t, l) => Math.max(t, l.time), -Infinity);
  const entrance = (pv: PvName) => {
    const t = lastNear(pvCentre[pv]);
    return map.points.some((p) => p.region === Region[pv] && p.time > t && !p.excluded && p.bipolar < EVIDENCE.silentPv);
  };
  const exit = (pv: PvName) => {
    const t = lastNear(pvCentre[pv]);
    return gt.pacingLog.some((e) => e.site === 'roving' && e.rovingRegion === Region[pv] && e.end > t && e.localCapture === true && e.csFollows === false);
  };
  const lineShown = () =>
    Number.isFinite(lastLesion) &&
    gt.pacingLog.some(
      (e: PacingLogEntry) =>
        e.t0 > lastLesion &&
        (e.intervals.some((iv) => iv.ms !== null && iv.ms >= EVIDENCE.lineBlockMs && iv.distance <= EVIDENCE.lineBlockMm) ||
          map.points.filter((p) => p.time >= e.t0 && p.time <= e.end).length >= EVIDENCE.pacedMapPoints),
    );
  const pvRow = (pv: PvName) => gt.pv.find((p) => p.pv === pv)!;
  const allPvi = (): Criterion => {
    const bad = PV_NAMES.filter((pv) => !pvRow(pv).durable);
    const edemaOnly = PV_NAMES.filter((pv) => pvRow(pv).isolated && !pvRow(pv).durable);
    return {
      label: 'All four PVs isolated (durable)',
      passed: bad.length === 0,
      detail: bad.length === 0 ? 'Every vein is electrically isolated by permanent lesion cores.' : `Still connected: ${bad.join(', ')}${edemaOnly.length ? ` (${edemaOnly.join(', ')} blocked only by edema)` : ''}.`,
    };
  };
  const earliestWithin = (mm: number): Criterion => {
    const d = map.earliest && gt.earliest ? dist(map.earliest, gt.earliest) : NaN;
    return {
      label: `Earliest mapped activation within ${mm} mm of the true site`,
      passed: d <= mm,
      detail: Number.isFinite(d) ? `Earliest mapped site is ${d.toFixed(1)} mm from the true site.` : 'No LAT map was built.',
    };
  };
  const sinusEnd = (): Criterion => ({
    label: 'Sinus rhythm at the end of the case',
    passed: gt.rhythm === 'sinus',
    detail: gt.rhythm === 'sinus' ? 'The atria are in sinus rhythm.' : 'The atria are not in sinus rhythm.',
  });

  const criteria: Criterion[] = [];
  switch (gt.scenario?.id) {
    case 'sinus':
      criteria.push({ label: 'LAT map covers at least 80 % of the LA surface', passed: map.coverage >= 0.8, detail: `Coverage ${(100 * map.coverage).toFixed(0)} %.` });
      criteria.push(earliestWithin(10));
      break;
    case 'paf':
      criteria.push(allPvi());
      criteria.push({ label: 'Entrance block shown in every PV', passed: PV_NAMES.every(entrance), detail: veinList(entrance) });
      criteria.push({ label: 'Exit block shown in every PV', passed: PV_NAMES.every(exit), detail: veinList(exit) });
      break;
    case 'persistent':
      criteria.push(allPvi());
      criteria.push(sinusEnd());
      break;
    case 'pmf':
    case 'roof':
    case 'typical': {
      const id = gt.scenario.id;
      const line = id === 'pmf' ? gt.mitralBlock : id === 'roof' ? gt.roofBlock : gt.ctiBlock;
      const name = id === 'pmf' ? 'mitral isthmus' : id === 'roof' ? 'roof' : 'cavotricuspid isthmus';
      criteria.push({ label: `Complete ${name} block`, passed: line.durable, detail: line.durable ? 'The line joins its anatomical anchors with no conducting gap.' : line.now ? 'Blocked now, but only because of edema.' : 'The line has a conducting gap or does not reach its anchors.' });
      criteria.push({ ...sinusEnd(), label: 'Tachycardia terminated, sinus rhythm at the end' });
      criteria.push({ label: 'Line block demonstrated by pacing', passed: lineShown(), detail: lineShown() ? 'A pacing manoeuvre after the line shows the detour around it.' : `Pace after completing the line: a stimulus-to-electrogram time ≥ ${EVIDENCE.lineBlockMs} ms to a bipole within ${EVIDENCE.lineBlockMm} mm, or a paced activation map (≥ ${EVIDENCE.pacedMapPoints} points).` });
      break;
    }
    case 'focal': {
      const s = gt.sources[0];
      criteria.push({ label: 'Focus eliminated (durable)', passed: !!s && (s.eliminated || s.isolated), detail: s?.eliminated ? 'The focus lies in a permanent lesion core.' : s?.isolated ? 'The focus is isolated from the atrium.' : 'The focus is still active.' });
      criteria.push(sinusEnd());
      criteria.push(earliestWithin(8));
      break;
    }
    case 'redo': {
      const pv = gt.truth?.gapPv;
      criteria.push(allPvi());
      criteria.push({ label: 'Gap in the previous lesion set closed', passed: !!gt.gapClosed && !!pv && pvRow(pv).durable, detail: gt.gapClosed ? 'A new lesion covers the gap.' : 'No new lesion was placed in the gap.' });
      const ok = !!pv && entrance(pv) && exit(pv);
      criteria.push({ label: 'Entrance and exit block shown in the reconnected vein', passed: ok, detail: pv ? `${pv}: entrance ${entrance(pv) ? 'shown' : 'not shown'}, exit ${exit(pv) ? 'shown' : 'not shown'}.` : '' });
      break;
    }
  }

  const warnings: string[] = [];
  if (gt.safety.esophagealWarnings) warnings.push(`${gt.safety.esophagealWarnings} lesion(s) reached the esophageal temperature warning (max ${gt.safety.maxEsophagealTemp.toFixed(1)} °C).`);
  if (gt.safety.lesionsInEsophagealZone) warnings.push(`${gt.safety.lesionsInEsophagealZone} lesion(s) over the esophagus.`);
  if (gt.safety.highForceLesions) warnings.push(`${gt.safety.highForceLesions} lesion(s) with mean contact force above 40 g.`);
  if (gt.lesions.belowTarget) warnings.push(`${gt.lesions.belowTarget} lesion(s) below the LQI target (risk of reconnection).`);

  const included = map.points.filter((p) => !p.excluded).length;
  return {
    criteria,
    success: criteria.length > 0 && criteria.every((c) => c.passed),
    map: { points: map.points.length, included, coverage: map.coverage, density: map.areaCm2 > 0 ? included / map.areaCm2 : 0 },
    lesions: { ...gt.lesions, gaps: lesionGaps(user, gapThreshold).length },
    procedure: { simSeconds: gt.simTime / 1000, wallMinutes: gt.wallMs / 60000, inductions: gt.inductions, cardioversions: gt.cardioversions, pacingManoeuvres: gt.pacingLog.length },
    safety: { warnings },
  };

  function veinList(f: (pv: PvName) => boolean): string {
    return PV_NAMES.map((pv) => `${pv} ${f(pv) ? '✓' : '—'}`).join(' · ');
  }
}
