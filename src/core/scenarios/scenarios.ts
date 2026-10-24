import type { SurfaceMesh } from '../mesh/types';
import { Region, PV_NAMES, type PvName } from '../mesh/regions';
import { PRESETS, sinusSites, type TissuePreset } from '../ep/tissue';
import { verticesNear } from '../ep/stimulus';
import { Rng } from '../rng';
import { getV, type Vec3 } from '../math/vec3';
import { antralRing } from '../ablation/rings';
import { MeshTools } from './geometry';
import { edgeDijkstra } from '../mesh/geodesic';

/**
 * Clinical teaching scenarios (MODEL.md §6.2). Each scenario builds a seeded, randomized ground
 * truth (substrate, prior lesions, ectopic sources, the arrhythmia and how it starts) plus public
 * case information and explicit success criteria. Ground truth never reaches the mapping code;
 * it is used by the solver, the end-of-case report and the teacher view.
 */
export type ScenarioId = 'sinus' | 'paf' | 'persistent' | 'pmf' | 'roof' | 'focal' | 'redo';

export const SCENARIO_IDS: ScenarioId[] = ['sinus', 'paf', 'persistent', 'pmf', 'roof', 'focal', 'redo'];

/** Case information shown to the learner (no ground truth). */
export interface ScenarioPublic {
  id: ScenarioId;
  name: string;
  presentation: string;
  goal: string;
  criteria: string[];
  /** Needs the reaction–diffusion solver (arrhythmias, pacing). */
  requiresRd: boolean;
}

/** An ectopic source: an automatic focus, or a trigger firing intermittent bursts. */
export type SourceSpec = {
  name: string;
  /** Stimulated vertices (≈ 2 mm radius) and their centre. */
  vertices: Uint32Array;
  centre: number;
  pv?: PvName;
} & (
  | { mode: 'automatic'; cl: number }
  | { mode: 'triggered'; beats: [number, number]; cl: [number, number]; interval: [number, number] }
);

/**
 * How the arrhythmia starts (a numerical stand-in for clinical induction):
 *  - line: a transient line of block with a stimulus beside it (unidirectional block), released
 *    once the stimulated side has recovered, launches a macro-reentry in one direction;
 *  - crossfield: an S2 over a patch in the refractory tail of a sinus beat creates a wave break.
 */
export type Induction =
  | { kind: 'line'; block: Uint32Array; stim: Uint32Array; at: number; release: number }
  | { kind: 'crossfield'; s1: Uint32Array; s2: Uint32Array; /** S2 time = 1 + s2Base + APD90 (measured at build). */ s2Base: number };

export interface ScenarioTruth {
  summary: string;
  /** True earliest-activation vertex of the clinical rhythm (sinus breakthrough or focus). */
  earliestVertex?: number;
  focusVertex?: number;
  triggerPvs?: PvName[];
  circuit?: 'perimitral' | 'roof';
  gapPv?: PvName;
  /** Centre of the gap and the positions of the missing lesions. */
  gapVertex?: number;
  gapVertices?: number[];
  /** The site that distance labels refer to (critical isthmus, focus, trigger or gap; MODEL.md §7.2). */
  criticalVertices?: number[];
  criticalLabel?: string;
}

export interface PriorLesion {
  vertex: number;
  power: number;
  duration: number;
  force: number;
}

export interface ScenarioSetup {
  info: ScenarioPublic;
  seed: number;
  preset: TissuePreset;
  fibrosisScale: number;
  sinusCl: number;
  /** Per-vertex conductivity multipliers (slow conduction zones). */
  slowZones: Array<{ centre: Vec3; radius: number; conductivity: number }>;
  priorLesions: PriorLesion[];
  sources: SourceSpec[];
  induction: Induction[];
  truth: ScenarioTruth;
}

const PRIOR = { power: 35, duration: 20, force: 15 };
const WACA_OFFSET = 7;

const PUBLIC: Record<ScenarioId, Omit<ScenarioPublic, 'id'>> = {
  sinus: {
    name: 'Sinus rhythm mapping',
    presentation: 'Pre-procedure substrate study in sinus rhythm.',
    goal: 'Build an activation map of the LA in sinus rhythm and locate the earliest breakthrough.',
    criteria: ['LAT map covers at least 80 % of the LA surface', 'Earliest mapped activation within 10 mm of the true breakthrough'],
    requiresRd: false,
  },
  paf: {
    name: 'Paroxysmal AF — PV triggers',
    presentation: 'Symptomatic paroxysmal AF. Frequent atrial ectopy and short runs of AF from the pulmonary veins.',
    goal: 'Isolate all four pulmonary veins and prove it with entrance and exit block.',
    criteria: ['All four PVs isolated (durable, not edema-dependent)', 'Entrance block shown in every PV (no PV potentials on a point inside the vein)', 'Exit block shown in every PV (pacing inside the vein captures locally without conducting to the atrium)'],
    requiresRd: true,
  },
  persistent: {
    name: 'Persistent AF — remodeled substrate',
    presentation: 'Persistent AF for 14 months. Dilated, fibrotic atrium; the patient arrives in AF.',
    goal: 'Isolate all four pulmonary veins, restore sinus rhythm (cardioversion is allowed), and review the low-voltage substrate.',
    criteria: ['All four PVs isolated (durable)', 'Sinus rhythm at the end of the case'],
    requiresRd: true,
  },
  pmf: {
    name: 'Perimitral flutter',
    presentation: 'Recurrent regular atrial tachycardia after a previous wide-area PV isolation.',
    goal: 'Diagnose the circuit (activation map, entrainment) and terminate it with a mitral isthmus line; prove block by differential pacing.',
    criteria: ['Complete mitral isthmus block (annulus connected to the PV isolation line)', 'Tachycardia terminated, sinus rhythm at the end', 'Line block demonstrated by pacing (long stimulus-to-electrogram time across the line)'],
    requiresRd: true,
  },
  roof: {
    name: 'Roof-dependent flutter',
    presentation: 'Regular atrial tachycardia after a previous wide-area PV isolation.',
    goal: 'Diagnose the circuit and terminate it with a roof line joining the two PV isolation lines; prove block by pacing.',
    criteria: ['Complete roof block (left and right PV isolation lines connected)', 'Tachycardia terminated, sinus rhythm at the end', 'Line block demonstrated by pacing (long stimulus-to-electrogram time across the line)'],
    requiresRd: true,
  },
  focal: {
    name: 'Focal atrial tachycardia',
    presentation: 'Incessant regular atrial tachycardia, normal atrial size.',
    goal: 'Find the earliest site on the activation map and ablate the focus.',
    criteria: ['Focus eliminated (durable)', 'Sinus rhythm at the end of the case', 'Earliest mapped activation within 8 mm of the focus'],
    requiresRd: true,
  },
  redo: {
    name: 'Redo PVI — reconnection gap',
    presentation: 'AF recurrence 9 months after PV isolation. One vein has reconnected through a gap in the old lesion line.',
    goal: 'Find the reconnected vein and the gap, close it, and re-establish isolation of all veins.',
    criteria: ['All four PVs isolated (durable)', 'Gap in the previous lesion set closed', 'Entrance and exit block shown in the reconnected vein'],
    requiresRd: true,
  },
};

export function scenarioInfo(id: ScenarioId): ScenarioPublic {
  return { id, ...PUBLIC[id] };
}

/** A seeded focus site in a vein's sleeve, 4–8 mm into the vein (≈ 2 mm radius). */
export function pvSleeveFocus(mesh: SurfaceMesh, pv: PvName, r: Rng): { centre: number; vertices: Uint32Array } {
  const P = mesh.positions;
  const lm = mesh.anatomy!.pvs.find((p) => p.name === pv)!;
  const depth = r.uniform(4, 8);
  const c: Vec3 = [lm.ostiumCenter[0] + lm.axis[0] * depth, lm.ostiumCenter[1] + lm.axis[1] * depth, lm.ostiumCenter[2] + lm.axis[2] * depth];
  const sleeve = Region[pv];
  let best = -1, bd = Infinity;
  for (let i = 0; i < mesh.region.length; i++) {
    if (mesh.region[i] !== sleeve) continue;
    const d = Math.hypot(P[3 * i]! - c[0], P[3 * i + 1]! - c[1], P[3 * i + 2]! - c[2]) + r.uniform(0, 2);
    if (d < bd) { bd = d; best = i; }
  }
  return { centre: best, vertices: verticesNear(P, getV(P, best), 2) };
}

/** Build the seeded ground truth for a scenario on a mesh, including its critical site. */
export function buildScenario(mesh: SurfaceMesh, id: ScenarioId, seed: number): ScenarioSetup {
  const setup = buildScenarioCore(mesh, id, seed);
  const t = setup.truth;
  const tools = new MeshTools(mesh);
  const P = mesh.positions;
  const ring = (pvs: PvName[]) => tools.dilate(antralRing(mesh, pvs, WACA_OFFSET, 4), 2);
  if (t.circuit === 'perimitral') {
    t.criticalVertices = tools.path(tools.loop('MV'), [...ring(['LSPV', 'LIPV'])]);
    t.criticalLabel = 'mitral isthmus';
  } else if (t.circuit === 'roof') {
    const top = (z: Set<number>) => [...z].filter((v) => P[3 * v + 2]! > 10);
    t.criticalVertices = tools.path(top(ring(['LSPV', 'LIPV'])), top(ring(['RSPV', 'RIPV'])));
    t.criticalLabel = 'roof isthmus';
  } else if (t.gapVertices?.length) {
    t.criticalVertices = [...t.gapVertices];
    t.criticalLabel = 'reconnection gap';
  } else if (t.focusVertex !== undefined) {
    t.criticalVertices = [t.focusVertex];
    t.criticalLabel = 'focus';
  } else if (setup.sources.length) {
    t.criticalVertices = setup.sources.map((s) => s.centre);
    t.criticalLabel = 'PV trigger';
  } else if (id === 'sinus' && t.earliestVertex !== undefined) {
    t.criticalVertices = [t.earliestVertex];
    t.criticalLabel = 'sinus breakthrough';
  }
  return setup;
}

function buildScenarioCore(mesh: SurfaceMesh, id: ScenarioId, seed: number): ScenarioSetup {
  const rng = new Rng(seed * 7919 + SCENARIO_IDS.indexOf(id));
  const tools = new MeshTools(mesh);
  const P = mesh.positions;
  const bb = sinusSites(mesh)[0]!;
  const base = (preset: TissuePreset, extra: Partial<ScenarioSetup> = {}): ScenarioSetup => ({
    info: scenarioInfo(id),
    seed,
    preset,
    fibrosisScale: 1,
    sinusCl: Math.round(rng.uniform(750, 950)),
    slowZones: [],
    priorLesions: [],
    sources: [],
    induction: [],
    truth: { summary: '', earliestVertex: bb.vertices[0] },
    ...extra,
  });
  const pvTrigger = (pv: PvName, r: Rng): SourceSpec => {
    const f = pvSleeveFocus(mesh, pv, r);
    return { name: `${pv} trigger`, pv, ...f, mode: 'triggered', beats: [3, 8], cl: [170, 230], interval: [3500, 8000] };
  };
  const ringLesions = (pvs: PvName | PvName[], offset: number, skip: (k: number, n: number) => boolean = () => false): PriorLesion[] => {
    const ring = antralRing(mesh, pvs, offset, 4);
    return ring.filter((_, k) => !skip(k, ring.length)).map((vertex) => ({ vertex, ...PRIOR }));
  };
  const postPviFlutterTissue = (): TissuePreset => ({
    ...PRESETS.paroxysmal,
    targetCv: rng.uniform(0.56, 0.64),
    fibrosis: { density: 0, pattern: 'patchy' },
  });

  switch (id) {
    case 'sinus':
      return base(PRESETS.healthy, { truth: { summary: 'Healthy atrium; earliest breakthrough at the Bachmann bundle insertion.', earliestVertex: bb.vertices[0] } });

    case 'paf': {
      const pvs = [...PV_NAMES];
      const n = rng.next() < 0.6 ? 1 : 2;
      const trig: PvName[] = [];
      while (trig.length < n) { const p = pvs[rng.int(0, 4)]!; if (!trig.includes(p)) trig.push(p); }
      return base(PRESETS.paroxysmal, {
        sources: trig.map((p) => pvTrigger(p, rng.fork(trig.indexOf(p)))),
        truth: { summary: `Ectopic triggers in ${trig.join(' and ')}.`, earliestVertex: bb.vertices[0], triggerPvs: trig },
      });
    }

    case 'persistent': {
      const setup = base(PRESETS.persistent, { fibrosisScale: rng.uniform(0.9, 1.2) });
      setup.induction = [crossField(mesh, tools, rng, bb.vertices)];
      setup.truth = { summary: 'Fibrotic, electrically remodeled atrium sustaining multiple-wavelet AF; induced from a wave break.', earliestVertex: bb.vertices[0] };
      return setup;
    }

    case 'pmf':
    case 'roof': {
      const prior = [...ringLesions(['LSPV', 'LIPV'], WACA_OFFSET), ...ringLesions(['RSPV', 'RIPV'], WACA_OFFSET)];
      const setup = base(postPviFlutterTissue(), { priorLesions: prior });
      // The induction line runs between the prior lines; its vertices are found from the ring
      // positions (the rings themselves become barriers once rasterized).
      const left = new Set(ringLesions(['LSPV', 'LIPV'], WACA_OFFSET).map((l) => l.vertex));
      const right = new Set(ringLesions(['RSPV', 'RIPV'], WACA_OFFSET).map((l) => l.vertex));
      const leftZone = tools.dilate(left, 2), rightZone = tools.dilate(right, 2);
      const ccw = rng.next() < 0.5;
      if (id === 'pmf') {
        const mv = tools.loop('MV');
        const path = tools.path(mv, [...leftZone]);
        const line = tools.dilate(path, 1);
        const end = path[path.length - 1]!; // on the annulus
        const th = tools.mitralAngle();
        const side = ccw ? 1 : -1;
        const stim = [...tools.dilate(line, 3)].filter((v) => !line.has(v) && tools.distance(v, end) < 8 && side * Math.sin(th(v) - th(end)) > 0);
        setup.induction = [{ kind: 'line', block: Uint32Array.from(line), stim: Uint32Array.from(stim), at: 1, release: 230 }];
        setup.truth = { summary: `Perimitral macro-reentry (${ccw ? 'counter-clockwise' : 'clockwise'} in this view of the annulus) after wide-area PVI.`, circuit: 'perimitral' };
      } else {
        // Transient line across the mid posterior wall between the rings; stimulus above (or below) it.
        const mid = (zone: Set<number>) => [...zone].filter((v) => Math.abs(P[3 * v + 2]!) < 6 && P[3 * v + 1]! > 0);
        const path = tools.path(mid(leftZone), mid(rightZone));
        const line = tools.dilate(path, 1);
        const end = path[Math.floor(path.length / 2)]!;
        // Stimulus above the line: the wave ascends the posterior wall (the descending launch does not sustain on this anatomy).
        const up = 1;
        const stim = [...tools.dilate(line, 3)].filter((v) => !line.has(v) && tools.distance(v, end) < 8 && up * (P[3 * v + 2]! - P[3 * end + 2]!) > 0);
        setup.induction = [{ kind: 'line', block: Uint32Array.from(line), stim: Uint32Array.from(stim), at: 1, release: 230 }];
        setup.truth = { summary: 'Roof-dependent figure-of-eight macro-reentry around both PV isolation lines (ascending posterior wall, descending anterior wall) after wide-area PVI.', circuit: 'roof' };
      }
      return setup;
    }

    case 'focal': {
      const sites: Array<[string, Region[]]> = [
        ['LA appendage base', [Region.LAA]],
        ['mitral annulus', [Region.MitralAnnulus]],
        ['septum', [Region.Septum]],
        ['right superior PV antrum', [Region.RSPVAntrum]],
        ['left superior PV antrum', [Region.LSPVAntrum]],
        ['roof', [Region.Roof]],
      ];
      const [name, regions] = sites[rng.int(0, sites.length)]!;
      const cand: number[] = [];
      mesh.region.forEach((r, i) => { if (regions.includes(r)) cand.push(i); });
      const centre = cand[rng.int(0, cand.length)]!;
      const cl = Math.round(rng.uniform(320, 420));
      return base(rng.next() < 0.5 ? PRESETS.healthy : PRESETS.paroxysmal, {
        sources: [{ name: 'Focus', centre, vertices: verticesNear(P, getV(P, centre), 2), mode: 'automatic', cl }],
        truth: { summary: `Automatic focus at the ${name}, cycle length ${cl} ms.`, earliestVertex: centre, focusVertex: centre },
      });
    }

    case 'redo': {
      const gapPv = PV_NAMES[rng.int(0, 4)]!;
      const prior: PriorLesion[] = [];
      const gapVertices: number[] = [];
      for (const pv of PV_NAMES) {
        const ring = antralRing(mesh, pv, 5, 4);
        // Two consecutive lesions missing from the reconnected vein's ring (≈ 8–12 mm gap).
        const g = pv === gapPv ? rng.int(0, ring.length) : -1;
        ring.forEach((vertex, k) => {
          if (g >= 0 && (k === g || k === (g + 1) % ring.length)) { gapVertices.push(vertex); return; }
          prior.push({ vertex, ...PRIOR });
        });
      }
      return base(PRESETS.paroxysmal, {
        priorLesions: prior,
        sources: [pvTrigger(gapPv, rng.fork(9))],
        truth: { summary: `${gapPv} reconnected through a gap in the previous ring; trigger in the same vein.`, earliestVertex: bb.vertices[0], gapPv, gapVertex: gapVertices[0], gapVertices, triggerPvs: [gapPv] },
      });
    }
  }
}

/**
 * Cross-field S1–S2 induction for the persistent-AF substrate (MODEL.md §6.2): S1 from the sinus
 * breakthrough; S2 over a 15 mm patch centred ≈ 60 ms (≈ 30 mm at 0.5 m/s) down the S1 wavefront,
 * delivered APD90 + 5–20 ms after the patch centre activates, so the S2 wave can only propagate
 * back into recovered tissue and breaks at the refractory tail.
 */
function crossField(mesh: SurfaceMesh, tools: MeshTools, rng: Rng, s1: Uint32Array): Induction {
  const P = mesh.positions;
  const d = edgeDijkstra(P, tools.adj, s1, 40).distance;
  const cand: number[] = [];
  for (let i = 0; i < d.length; i++) if (d[i]! > 28 && d[i]! < 32 && !PV_SLEEVE.has(mesh.region[i]!)) cand.push(i);
  const c = cand[rng.int(0, cand.length)]!;
  return { kind: 'crossfield', s1, s2: verticesNear(P, getV(P, c), 15), s2Base: 60 + rng.uniform(5, 20) };
}

const PV_SLEEVE = new Set<number>([Region.LSPV, Region.LIPV, Region.RSPV, Region.RIPV, Region.LAA]);
