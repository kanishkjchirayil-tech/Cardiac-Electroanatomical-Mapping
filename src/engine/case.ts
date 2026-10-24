import type { SurfaceMesh } from '../core/mesh/types';
import type { Simulation } from '../core/ep/simulation';
import type { Substrate } from '../core/ep/substrate';
import type { TissueGeometry } from '../core/ep/fem';
import type { SinusSite } from '../core/ep/tissue';
import type { EgmSamples } from '../core/ep/backend';
import type { ElectrogramRig } from '../core/signals/rig';
import { EGM_FS } from '../core/signals/rig';
import type { LeadField } from '../core/signals/leadfield';
import { PV_NAMES } from '../core/mesh/regions';
import { getV, type Vec3 } from '../core/math/vec3';
import { Rng } from '../core/rng';
import { CATHETER_RADIUS } from '../core/catheter/roving';
import { captureFootprint } from '../core/pacing/capture';
import { cycleLengthOf, firstActivation, median, SignalHistory } from '../core/pacing/analysis';
import type { PacingRequest, PacingSite } from '../core/pacing/protocols';
import type { ScenarioSetup } from '../core/scenarios/scenarios';
import { ConductionGraph, barrierComponents, openingComponent, pvConnectedFraction } from '../core/scenarios/topology';
import { applyLesionsToSubstrate, type AblationController } from '../core/ablation/controller';
import { LESION_TARGET_LQI } from '../core/ablation/lesion';
import { RF_CONSTANTS } from '../core/ablation/rf';
import { InductionDriver, PacingDriver, Probes, SinusDriver, SourceDriver } from './drivers';
import type { CaseGroundTruth, FromWorker, PacingInterval, PacingLogEntry, PacingStatus } from './protocol';

/** What the case controller needs from the engine. */
export interface CaseHost {
  mesh: SurfaceMesh;
  sim: Simulation;
  rig: ElectrogramRig;
  substrate: Substrate;
  geom: TissueGeometry;
  D0: number;
  apd90: number;
  sinusSites: SinusSite[];
  ablation: AblationController;
  esophagealZone: Uint8Array;
  lesionSource(): Float32Array | null;
  setTransientBlock(v: Uint32Array | null): void;
  refChannel(): number;
  /** Switch the timing reference to another channel (by name). */
  setReference(name: string): void;
  post(msg: FromWorker): void;
}

/** Bipolar channels used for pacing measurements: CS pairs and the ablation catheter's bipoles. */
const MEASURE_CHANNELS = ['CS 1-2', 'CS 3-4', 'CS 5-6', 'CS 7-8', 'CS 9-10', 'MAP 1-2', 'MAP 3-4'];
const PACE_PAIR: Record<PacingSite, { pair: string; neighbour: string }> = {
  roving: { pair: 'MAP 1-2', neighbour: 'MAP 3-4' },
  'cs-distal': { pair: 'CS 1-2', neighbour: 'CS 3-4' },
  'cs-proximal': { pair: 'CS 9-10', neighbour: 'CS 7-8' },
};
/** Scenarios whose arrhythmia should be running at the start of the case (re-induced if it stops before any ablation). */
const SUSTAINED = new Set(['persistent', 'pmf', 'roof', 'focal']);

/**
 * Reaction–diffusion case runtime (MODEL.md §6): sinus node with reset, ectopic sources,
 * scripted induction, pacing delivery and analysis, cardioversion, and the ground-truth report.
 */
export class CaseController {
  readonly probes = new Probes();
  private sinus: SinusDriver;
  private sources: SourceDriver[] = [];
  private pacing: PacingDriver;
  private induction: InductionDriver | null = null;
  private hist: SignalHistory;

  private footprintKey = '';
  private analyzed: Array<{ t: number; intervals: Map<string, number>; local: boolean | null; cs: boolean | null; captured: boolean }> = [];
  private pendingStims: number[] = [];
  private captureEvents: number[] = [];
  private paceTcl = NaN;
  private status: PacingStatus | null = null;
  private finalizeAt = Infinity;
  readonly log: PacingLogEntry[] = [];
  cardioversions = 0;
  private readonly startWall = performance.now();
  private rearmAfter = 0;
  private refChecked = false;

  constructor(private readonly h: CaseHost, readonly setup: ScenarioSetup | null, sinusCl: number, siteIndex: { sinus: number[]; pace: number; sources: number[]; induction: number }) {
    const sites = h.sinusSites.map((s, k) => ({ index: siteIndex.sinus[k]!, delay: s.delay }));
    this.sinus = new SinusDriver(h.sim, sites, sinusCl);
    this.probes.set('bb', h.sinusSites[0]!.vertices[0]!);
    this.pacing = new PacingDriver(h.sim, siteIndex.pace);
    const rng = new Rng((setup?.seed ?? 1) * 31 + 7);
    (setup?.sources ?? []).forEach((spec, k) => {
      this.sources.push(new SourceDriver(h.sim, siteIndex.sources[k]!, spec, rng.fork(k), 0));
      this.probes.set(`src${k}`, spec.centre);
    });
    if (setup?.induction.length) {
      this.induction = new InductionDriver(h.sim, siteIndex.induction, setup.induction, { block: (v) => h.setTransientBlock(v), apd: h.apd90 });
      this.induction.arm(1);
      // A line induction needs quiet tissue: the first sinus beat waits until the circuit is running
      // (it is then reset, i.e. suppressed, by the tachycardia).
      if (setup.induction.some((i) => i.kind === 'line')) this.sinus.restart(600);
    }
    this.hist = new SignalHistory(h.rig.channels.length, EGM_FS, 8);
    this.updateSources();
  }

  setSinusCl(cl: number, now: number): void {
    this.sinus.cl = cl;
    this.sinus.restart(now + 1);
  }

  probeRows(): LeadField[] {
    return this.probes.rows();
  }

  /** Schedule stimuli due in the coming piece (call before advancing to `end`). */
  beforePiece(now: number, end: number): void {
    this.induction?.step(end);
    this.sinus.schedule(end);
    for (const s of this.sources) s.schedule(end);
    if (this.pacing.req) this.updateFootprint();
    for (const t of this.pacing.stimsIn(now, end)) this.pendingStims.push(t);
  }

  /** Probe samples from the solver (columns after the rig's electrodes). */
  onProbeSamples(s: EgmSamples, offset: number): void {
    for (const e of this.probes.scan(s, offset)) {
      if (e.name === 'bb') this.sinus.onActivation(e.t);
      else if (e.name === 'pace') this.captureEvents.push(e.t);
      else if (e.name.startsWith('src')) this.sources[Number(e.name.slice(3))]?.onActivation(e.t);
    }
    if (this.captureEvents.length > 200) this.captureEvents.splice(0, 100);
  }

  /** Processed channels (all rig channels) for pacing analysis. */
  onSignals(p: { t0: number; n: number; data: Float32Array }, now: number): void {
    this.hist.push(p.t0, p.data, p.n);
    this.analyzeStims();
    if (now >= this.finalizeAt) this.finalize(now);
    this.maybeRearm(now);
    if (!this.refChecked && now > 1500) this.checkReference(now);
  }

  /**
   * Once per case: if the reference bipole records almost nothing (for example, it lies over old
   * scar), switch to the CS bipole with the largest signal — what a technician would do.
   */
  private checkReference(now: number): void {
    this.refChecked = true;
    const ppk = (ch: number) => {
      const { x } = this.hist.window(ch, now - 1200, now);
      let mn = Infinity, mx = -Infinity;
      for (const v of x) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
      return x.length ? mx - mn : 0;
    };
    const ref = this.h.refChannel();
    if (ppk(ref) >= 0.3) return;
    let best = '', bp = 0;
    for (const name of ['CS 1-2', 'CS 3-4', 'CS 5-6', 'CS 7-8', 'CS 9-10']) {
      const ch = this.channelIndex(name);
      const v = ch >= 0 ? ppk(ch) : 0;
      if (v > bp) { bp = v; best = name; }
    }
    if (best && bp >= 0.5) this.h.setReference(best);
  }

  /** Stimulus times delivered in (a, b] (for EGM markers). */
  stimsIn(a: number, b: number): number[] {
    return this.pacing.stimsIn(a, b);
  }

  // ---- Pacing ----------------------------------------------------------------------------------

  startPacing(req: PacingRequest, now: number): void {
    if (this.status?.active) this.finalize(now);
    if (req.site === 'roving' && this.h.rig.rovingState()?.config.type !== 'ablation') throw new Error('Roving pacing needs the ablation catheter.');
    this.footprintKey = '';
    this.pacing.start(req, now);
    this.analyzed = [];
    this.pendingStims = [];
    const ref = this.h.refChannel();
    this.paceTcl = cycleLengthOf(this.hist, ref, now - 3000, now);
    const r = this.h.rig.rovingState();
    this.status = {
      active: true, site: req.site, output: req.output, protocol: req.protocol, t0: this.pacing.t0, stims: 0,
      localCapture: null, csFollows: null, intervals: [], entrain: null,
      rovingVertex: r?.vertex ?? -1, rovingRegion: r ? this.h.mesh.region[r.vertex]! : 0,
    };
    // Entrainment waits for the post-pacing interval; other protocols only for the last beat's analysis.
    const tail = req.protocol.kind === 'entrain' ? Math.max(1200, 2.2 * (Number.isFinite(this.paceTcl) ? this.paceTcl : 400)) : 600;
    this.finalizeAt = Number.isFinite(this.pacing.end) ? this.pacing.end + tail : Infinity;
    this.updateFootprint();
    this.h.post({ type: 'pacing', status: { ...this.status } });
  }

  stopPacing(now: number): void {
    if (!this.pacing.req) return;
    this.pacing.stop();
    this.finalizeAt = now + 600;
  }

  /** Recompute the stimulated vertices from the electrode position and output. */
  updateFootprint(): void {
    const req = this.pacing.req;
    if (!req) return;
    const rig = this.h.rig, sub = this.h.substrate;
    const src = this.h.lesionSource();
    const exc = sub.excitable();
    const viable = (v: number) => (exc[v] ? (src ? src[v]! : 1) : 0);
    let p: Vec3, gap: number | undefined;
    if (req.site === 'roving') {
      const r = rig.rovingState();
      if (!r) return;
      p = r.pose.electrodes[0]!;
      gap = r.pose.gap;
    } else {
      p = rig.cs.electrodes[req.site === 'cs-distal' ? 0 : 8]!;
      gap = Math.max(0, rig.vertexIndex.nearest(p).distance - CATHETER_RADIUS);
    }
    const f = captureFootprint(rig.vertexIndex, this.h.mesh.positions, p, req.output, viable, gap);
    const key = `${f.vertices.length}:${f.vertices[0] ?? -1}:${f.vertices[f.vertices.length - 1] ?? -1}:${f.amplitude.toFixed(3)}`;

    this.probes.set('pace', f.nearest);
    if (key === this.footprintKey) return;
    this.footprintKey = key;
    const site = this.h.sim.schedule.sites[this.pacing.index]!;
    site.vertices = f.vertices;
    site.amplitude = f.amplitude;
    this.h.sim.markSitesChanged();
  }

  private channelIndex(name: string): number {
    return this.h.rig.channels.findIndex((c) => c.name === name);
  }

  private bipoleCentre(name: string): Vec3 | null {
    const rig = this.h.rig;
    const m = /^(CS|MAP) (\d+)-(\d+)$/.exec(name);
    if (!m) return null;
    const a = Number(m[2]) - 1, b = Number(m[3]) - 1;
    const el = m[1] === 'CS' ? rig.cs.electrodes : rig.rovingState()?.pose.electrodes;
    if (!el || !el[a] || !el[b]) return null;
    return [0, 1, 2].map((k) => 0.5 * (el[a]![k]! + el[b]![k]!)) as Vec3;
  }

  private cathode(): Vec3 | null {
    const req = this.pacing.req ?? (this.status ? { site: this.status.site } : null);
    if (!req) return null;
    if (req.site === 'roving') return this.h.rig.rovingState()?.pose.electrodes[0] ?? null;
    return this.h.rig.cs.electrodes[req.site === 'cs-distal' ? 0 : 8] ?? null;
  }

  /** Measure each stimulus once 400 ms of signal after it has been recorded. */
  private analyzeStims(): void {
    const st = this.status;
    if (!st) return;
    const tEnd = this.hist.tEnd;
    const pair = PACE_PAIR[st.site];
    const ref = this.h.refChannel();
    const cl = 'cl' in st.protocol ? st.protocol.cl : st.protocol.s1;
    let changed = false;
    while (this.pendingStims.length && this.pendingStims[0]! + 420 <= tEnd) {
      const t = this.pendingStims.shift()!;
      const intervals = new Map<string, number>();
      for (const name of MEASURE_CHANNELS) {
        if (name === pair.pair) continue;
        if (name.startsWith('MAP') && this.h.rig.rovingState()?.config.type !== 'ablation') continue;
        const ch = this.channelIndex(name);
        if (ch < 0) continue;
        const a = firstActivation(this.hist, ch, t + 4, t + Math.min(400, cl - 5));
        if (Number.isFinite(a)) intervals.set(name, a - t);
      }
      // Local capture: the neighbouring bipole activates within 60 ms, or the pacing bipole itself
      // shows the captured electrogram within 30 ms (no stimulus artifact is simulated).
      const nb = intervals.get(pair.neighbour);
      const pc = this.channelIndex(pair.pair);
      const own = pc >= 0 ? firstActivation(this.hist, pc, t + 3, t + 30) : NaN;
      const local = (nb !== undefined && nb < 60) || Number.isFinite(own);
      let cs: boolean | null = null;
      if (st.site === 'roving') cs = Number.isFinite(firstActivation(this.hist, ref, t + 4, t + Math.min(400, cl - 5)));
      const captured = this.captureEvents.some((e) => e >= t - 1 && e <= t + 25);
      this.analyzed.push({ t, intervals, local, cs, captured });
      st.stims++;
      changed = true;
    }
    if (!changed) return;
    // Summarize the most recent beats (skip the first two of a train while it settles).
    const recent = this.analyzed.length > 4 ? this.analyzed.slice(2).slice(-3) : this.analyzed.slice(-3);
    const centre = this.cathode();
    st.intervals = MEASURE_CHANNELS.filter((n) => n !== pair.pair && (!n.startsWith('MAP') || this.h.rig.rovingState()?.config.type === 'ablation')).map((name): PacingInterval => {
      const vals = recent.map((r) => r.intervals.get(name) ?? NaN);
      const ms = median(vals);
      const c = this.bipoleCentre(name);
      return { channel: name, ms: Number.isFinite(ms) ? Math.round(ms) : null, distance: centre && c ? Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]) : NaN };
    });
    // Capture is called when most recent stimuli show it (a coincident spontaneous beat is not enough).
    st.localCapture = recent.filter((r) => r.local).length * 2 > recent.length;
    st.csFollows = st.site === 'roving' ? recent.length > 0 && recent.every((r) => r.cs) : null;
    this.h.post({ type: 'pacing', status: { ...st, intervals: [...st.intervals] } });
  }

  private finalize(now: number): void {
    const st = this.status;
    if (!st) return;
    this.finalizeAt = Infinity;
    st.active = false;
    if (st.protocol.kind === 'entrain' && this.analyzed.length) {
      const last = this.analyzed[this.analyzed.length - 1]!.t;
      const ch = this.channelIndex(PACE_PAIR[st.site].pair);
      // The paced site was just captured and is refractory, so the return beat cannot come before
      // about half the pacing cycle; earlier deflections belong to the last captured beat.
      const cl = st.protocol.cl;
      const ret = ch >= 0 ? firstActivation(this.hist, ch, last + Math.max(80, 0.5 * cl), last + 1500) : NaN;
      if (Number.isFinite(ret) && Number.isFinite(this.paceTcl)) st.entrain = { tcl: Math.round(this.paceTcl), ppi: Math.round(ret - last), diff: Math.round(ret - last - this.paceTcl) };
    }
    this.pacing.stop();
    const captureTruth = this.analyzed.length ? this.analyzed.filter((a) => a.captured).length / this.analyzed.length : 0;
    this.log.push({ ...st, intervals: [...st.intervals], end: now, captureTruth });
    this.h.post({ type: 'pacing', status: { ...st } });
    this.status = null;
  }

  get pacingActive(): boolean {
    return !!this.status?.active;
  }

  // ---- Sources, induction, cardioversion ------------------------------------------------------------

  /** Sources whose centre is in a lesion core are eliminated (re-evaluated after every lesion change). */
  updateSources(): void {
    const core = this.h.substrate.lesionCore;
    for (const s of this.sources) {
      let n = 0;
      for (const v of s.spec.vertices) n += core[v]!;
      s.setActive(n < 0.5 * s.spec.vertices.length);
    }
  }

  /** Re-induce the scenario arrhythmia if it stopped before the learner has delivered any lesion. */
  private maybeRearm(now: number): void {
    const id = this.setup?.info.id;
    if (!id || !SUSTAINED.has(id) || !this.induction || this.induction.busy || now < this.rearmAfter) return;
    if (this.h.ablation.lesions.some((l) => !l.prior) || this.cardioversions > 0 || this.pacingActive) return;
    if (!this.sinus.inSinus(2) || this.induction.count >= 6) return;
    const t0 = this.induction.spec[0]!.kind === 'crossfield' ? this.sinus.next : this.sinus.lastFire + 450;
    if (t0 < now + 5) return;
    this.induction.arm(t0);
    this.rearmAfter = t0 + 1500;
  }

  get inductions(): number {
    return this.induction?.count ?? 0;
  }

  /** DC cardioversion: every cell is reset to rest; sinus rhythm resumes 300 ms later. */
  async cardiovert(now: number, setRest: () => Promise<void> | void): Promise<void> {
    this.pacing.stop();
    this.status = null;
    await setRest();
    this.cardioversions++;
    this.sinus.restart(now + 300);
  }

  inSinus(): boolean {
    return this.sinus.inSinus(2);
  }

  // ---- Ground truth report ----------------------------------------------------------------------

  report(now: number, sinusCl: number): CaseGroundTruth {
    return caseGroundTruth(this.h, this.setup, now, performance.now() - this.startWall, {
      rhythm: this.sinus.inSinus(2) || sinusCl <= 0 ? 'sinus' : 'not-sinus',
      inductions: this.inductions,
      cardioversions: this.cardioversions,
      pacingLog: this.log,
      sources: this.sources.map((s) => s.spec),
    });
  }
}

/** Ground-truth evaluation of the tissue and lesion set (also used in eikonal mode, with no drivers). */
export function caseGroundTruth(
  h: Pick<CaseHost, 'mesh' | 'substrate' | 'geom' | 'D0' | 'sinusSites' | 'ablation' | 'esophagealZone'>,
  setup: ScenarioSetup | null,
  now: number,
  wallMs: number,
  extra: { rhythm: 'sinus' | 'not-sinus'; inductions: number; cardioversions: number; pacingLog: PacingLogEntry[]; sources: ScenarioSetup['sources'] },
): CaseGroundTruth {
  const { mesh, substrate: sub } = h;
  const seeds = h.sinusSites.flatMap((s) => Array.from(s.vertices));
  const evaluate = (t: number) => {
    const saveCore = sub.lesionCore.slice(), saveCond = sub.lesionConductivity.slice();
    applyLesionsToSubstrate(sub, h.ablation.rasterize(t));
    const exc = sub.excitable();
    const g = new ConductionGraph(h.geom, sub.edgeDiffusivity(h.D0), exc);
    const body = g.reachable(seeds);
    const comp = barrierComponents(mesh, body);
    const core = sub.lesionCore.slice();
    sub.lesionCore.set(saveCore);
    sub.lesionConductivity.set(saveCond);
    const c = (l: string) => openingComponent(mesh, comp, l);
    const pvComp = PV_NAMES.map((p) => c(p));
    return {
      pv: PV_NAMES.map((p) => pvConnectedFraction(mesh, body, exc, p)),
      mitral: c('MV') >= 0 && pvComp.includes(c('MV')),
      roof: [c('LSPV'), c('LIPV')].some((x) => x >= 0 && (x === c('RSPV') || x === c('RIPV'))),
      sources: extra.sources.map((s) => {
        let n = 0;
        for (const v of s.vertices) n += core[v]!;
        return { name: s.name, eliminated: n >= 0.5 * s.vertices.length, isolated: !body[s.centre] };
      }),
    };
  };
  const cur = evaluate(now), dur = evaluate(Infinity);
  const user = h.ablation.lesions.filter((l) => !l.prior);
  const gv = (setup?.truth.gapVertices ?? []).map((v) => getV(mesh.positions, v));
  const gapMid = gv.length ? [0, 1, 2].map((k) => gv.reduce((acc, g) => acc + g[k]!, 0) / gv.length) : null;
  const ev = setup?.truth.earliestVertex;
  return {
    scenario: setup?.info ?? null,
    truth: setup?.truth ?? null,
    seed: setup?.seed ?? 0,
    simTime: now,
    wallMs,
    pv: PV_NAMES.map((pv, k) => ({ pv, connected: cur.pv[k]!, isolated: cur.pv[k] === 0, durable: dur.pv[k] === 0 })),
    mitralBlock: { now: cur.mitral, durable: dur.mitral },
    roofBlock: { now: cur.roof, durable: dur.roof },
    sources: cur.sources.map((s, k) => ({ ...s, eliminated: dur.sources[k]!.eliminated, isolated: dur.sources[k]!.isolated })),
    gapClosed: gapMid ? user.some((l) => Math.hypot(l.center[0] - gapMid[0]!, l.center[1] - gapMid[1]!, l.center[2] - gapMid[2]!) < 6) : null,
    rhythm: extra.rhythm,
    inductions: extra.inductions,
    cardioversions: extra.cardioversions,
    pacingLog: extra.pacingLog.map((e) => ({ ...e })),
    lesions: {
      user: user.length,
      prior: h.ablation.lesions.length - user.length,
      rfSeconds: user.reduce((a, l) => a + l.duration, 0),
      meanLqi: user.length ? user.reduce((a, l) => a + l.lqi, 0) / user.length : 0,
      belowTarget: user.filter((l) => l.lqi < LESION_TARGET_LQI).length,
    },
    safety: {
      esophagealWarnings: user.filter((l) => l.esophagealTemp >= RF_CONSTANTS.tempWarning).length,
      maxEsophagealTemp: user.reduce((a, l) => (Number.isFinite(l.esophagealTemp) ? Math.max(a, l.esophagealTemp) : a), 37),
      highForceLesions: user.filter((l) => l.meanForce > 40).length,
      lesionsInEsophagealZone: user.filter((l) => h.esophagealZone[l.vertex] === 1).length,
    },
    earliest: ev !== undefined ? [...getV(mesh.positions, ev)] : null,
  };
}

