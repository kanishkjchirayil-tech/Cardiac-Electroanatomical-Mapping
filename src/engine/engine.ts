import type { SurfaceMesh } from '../core/mesh/types';
import { calibrateDiffusivity, measureRestitution, type CalibrationResult } from '../core/ep/calibrate';
import { createIonicModel, type IonicSpec } from '../core/ep/ionic';
import { CpuBackend } from '../core/ep/solver-cpu';
import { WebGpuBackend } from '../core/ep/solver-gpu';
import { Simulation } from '../core/ep/simulation';
import type { SolverBackend } from '../core/ep/backend';
import { PRESETS, buildTissue, sinusSites, type SinusSite, type TissueBuild } from '../core/ep/tissue';
import { fastMarching, type ApTemplate } from '../core/ep/eikonal';
import { makeApTemplate } from '../core/ep/ap-template';
import { DEFAULT_SIM_CONFIG, type BeatWindow, type EgmChunk, type FromWorker, type RigInfo, type RovingFrame, type SimConfig, type SimInfo } from './protocol';
import { ElectrogramRig, EGM_FS, MOTION_UPDATE_MS } from '../core/signals/rig';
import { BeatExtractor } from '../core/signals/beats';
import { DEFAULT_SIGNALS, type SignalSettings } from '../core/signals/recording';
import { DEFAULT_ROVING, type RovingConfig } from '../core/catheter/roving';
import { Region } from '../core/mesh/regions';
import { getV } from '../core/math/vec3';
import type { EgmSamples } from '../core/ep/backend';
import { AblationController, DEFAULT_ABLATION, applyLesionsToSubstrate, type AblationSettings } from '../core/ablation/controller';
import { buildEsophagus, type EsophagusModel } from '../core/ablation/esophagus';
import type { RfFrame } from './protocol';
import { buildScenario, type ScenarioSetup } from '../core/scenarios/scenarios';
import type { PacingRequest } from '../core/pacing/protocols';
import { CaseController, caseGroundTruth, type CaseHost } from './case';

/**
 * Simulation engine hosted in a worker. Owns the tissue, the solver backend (WebGPU with CPU
 * fallback) or the eikonal activation map, and decouples simulation time from wall time:
 * each tick advances the clock by speed × elapsed wall time (or as fast as possible), and frames
 * are posted at ≤ 30 Hz with the measured speed.
 */
export class SimEngine {
  private mesh: SurfaceMesh | null = null;
  private config: SimConfig = { ...DEFAULT_SIM_CONFIG };
  private tissue: TissueBuild | null = null;
  private cal: CalibrationResult | null = null;
  private ionic: IonicSpec = PRESETS.healthy.ionic;
  private sim: Simulation | null = null;
  private backend: SolverBackend | null = null;
  private gpuError: string | null = null;
  private sites: SinusSite[] = [];
  private eikonalT: Float32Array | null = null;
  private template: ApTemplate | null = null;
  private eikT = 0;
  private running = false;
  /** Target speed (sim ms per wall ms); 0 = as fast as possible. */
  private speed = 1;
  /** Measured speed over a ~0.5 s wall-clock window: simulated ms per wall ms. */
  private speedMeasured = 0;
  private win = { wall0: 0, sim: 0 };
  private lastFrame = 0;
  private generation = 0;
  private busy: Promise<void> = Promise.resolve();
  // Recording rig and electrogram streaming.
  private rig: ElectrogramRig | null = null;
  private rovingVertex = -1;
  private rovingConfig: RovingConfig = { ...DEFAULT_ROVING };
  private signals: SignalSettings = DEFAULT_SIGNALS;
  private motionEnabled = true;
  private egmChunks: Array<{ t0: number; n: number; data: Float32Array }> = [];
  private nextMotionT = 0;
  /** Eikonal mode: one sinus cycle of the static (ECG + CS) electrode potentials, 0.5 ms steps. */
  private eikTable: { data: Float32Array; len: number; rows: number[] } | null = null;
  private eikNextSample = 0;
  private beats: BeatExtractor | null = null;
  private refName = 'CS 7-8';
  /** Indices of the channels shown in the EGM panel. */
  private displayIdx: number[] = [];
  // Ablation (MODEL.md §5).
  private ablation: AblationController | null = null;
  private esophagus: EsophagusModel | null = null;
  private ablationSettings: AblationSettings = { ...DEFAULT_ABLATION };
  /** Per-vertex EGM source multiplier and teacher-view lesion raster from the current lesions. */
  private lesionSource: Float32Array | null = null;
  private lesionKind: Uint8Array | null = null;
  private rfVertex = -1;
  // Scenario and case runtime (MODEL.md §6).
  private scenario: ScenarioSetup | null = null;
  private scenarioKey = '';
  private newCase = true;
  private caseCtl: CaseController | null = null;
  private caseWall0 = performance.now();
  private transientBlock: Uint32Array | null = null;
  private probeVersion = -1;
  private lastFrameT = 0;

  constructor(private readonly post: (msg: FromWorker, transfer?: Transferable[]) => void) {}

  /** Serialize all mutating operations so a rebuild never overlaps a running step. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(fn).catch((e) => this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
    return this.busy;
  }

  init(mesh: SurfaceMesh, config: SimConfig): Promise<void> {
    this.mesh = mesh;
    this.config = { ...config };
    this.ablation = null;
    return this.enqueue(() => this.rebuild());
  }

  configure(patch: Partial<SimConfig>): Promise<void> {
    const prev = this.config;
    this.config = { ...prev, ...patch };
    const onlySinus = Object.keys(patch).every((k) => k === 'sinusCl');
    if (onlySinus) return this.enqueue(async () => {
      this.applySinus();
      if (!this.sim) this.buildEikonalTable();
    });
    return this.enqueue(() => this.rebuild());
  }

  private async rebuild(): Promise<void> {
    if (!this.mesh) return;
    const oldNow = this.now();
    const gen = ++this.generation;
    const t0 = performance.now();
    const c = this.config;
    const key = c.scenario ? `${c.scenario.id}:${c.scenario.seed}:${c.scenario.run ?? 0}` : '';
    if (key !== this.scenarioKey) {
      this.scenarioKey = key;
      this.post({ type: 'status', message: 'Setting up the case…' });
      this.scenario = c.scenario ? buildScenario(this.mesh, c.scenario.id, c.scenario.seed) : null;
      this.newCase = true;
      if (this.scenario) c.sinusCl = this.scenario.sinusCl;
    }
    const sc = this.scenario;
    if (sc?.info.requiresRd) c.mode = 'rd';
    const preset = sc?.preset ?? PRESETS[c.preset];
    this.ionic = sc || c.ionic === 'ms' ? preset.ionic : { id: c.ionic };
    const model = createIonicModel(this.ionic);
    this.post({ type: 'status', message: 'Building tissue…' });
    this.tissue = sc
      ? buildTissue(this.mesh, preset, sc.seed, sc.fibrosisScale)
      : buildTissue(this.mesh, { ...preset, fibrosis: { ...preset.fibrosis, pattern: c.fibrosisPattern } }, c.seed, c.fibrosisScale);
    for (const z of sc?.slowZones ?? []) {
      const P = this.mesh.positions, cond = this.tissue.substrate.conductivity;
      for (let i = 0; i < cond.length; i++) if (Math.hypot(P[3 * i]! - z.centre[0], P[3 * i + 1]! - z.centre[1], P[3 * i + 2]! - z.centre[2]) < z.radius) cond[i] = z.conductivity;
    }
    this.transientBlock = null;
    if (this.newCase && this.ablation) this.ablation = null;
    if (!this.ablation) {
      this.esophagus = buildEsophagus(this.mesh, c.seed);
      this.ablation = new AblationController(this.mesh, this.esophagus.zone);
      for (const pl of sc?.priorLesions ?? []) {
        const L = this.ablation.deliver(pl.vertex, [...getV(this.mesh.positions, pl.vertex)] as [number, number, number], { ...DEFAULT_ABLATION, power: pl.power, duration: pl.duration, edema: false }, pl.force, 0);
        L.prior = true;
      }
    } else {
      // Lesions are tissue: they survive a rebuild; the clock restarts at 0.
      this.ablation.stop(oldNow);
      this.ablation.rebase(oldNow, 0);
    }
    this.rasterizeLesions(0);
    this.post({ type: 'status', message: 'Calibrating conduction velocity…' });
    const dt = model.recommendedDt;
    this.cal = await calibrateDiffusivity(this.ionic, preset.targetCv, { h: this.tissue.geom.meanEdge, dt });
    if (this.newCase) this.caseWall0 = performance.now();
    this.newCase = false;
    this.caseCtl = null;
    this.sites = sinusSites(this.mesh);
    this.template = makeApTemplate(model);
    this.backend?.dispose();
    this.backend = null;
    this.sim = null;
    this.eikonalT = null;
    let eikonalMs: number | null = null;
    const sub = this.tissue.substrate;
    if (c.mode === 'eikonal') {
      const te = performance.now();
      this.eikonalT = this.computeEikonal();
      eikonalMs = performance.now() - te;
      this.eikT = 0;
    } else {
      const init = {
        geom: this.tissue.geom,
        model,
        edgeD: sub.edgeDiffusivity(this.cal.D),
        apdScale: sub.apdScale,
        excitable: sub.excitable(),
        siteOf: new Int32Array(this.tissue.geom.nV).fill(-1),
        dt,
      };
      this.gpuError = null;
      if (c.backend === 'auto') {
        try {
          this.backend = await WebGpuBackend.create(init);
        } catch (e) {
          this.gpuError = e instanceof Error ? e.message : String(e);
        }
      }
      this.backend ??= new CpuBackend(init);
      this.sim = new Simulation(this.backend, dt);
      const sched = this.sim.schedule;
      const sinusIdx = this.sites.map((s) => sched.addSite({ name: s.name, vertices: s.vertices, amplitude: 0.5, duration: 2 }));
      const paceIdx = sched.addSite({ name: 'Pacing', vertices: new Uint32Array(0), amplitude: 0, duration: 2 });
      const srcIdx = (sc?.sources ?? []).map((src) => sched.addSite({ name: src.name, vertices: src.vertices, amplitude: 0.6, duration: 2 }));
      const indIdx = sc?.induction.length ? sched.addSite({ name: 'Induction', vertices: new Uint32Array(0), amplitude: 0.5, duration: 2 }) : -1;
      this.sim.markSitesChanged();
      this.siteIndex = { sinus: sinusIdx, pace: paceIdx, sources: srcIdx, induction: indIdx };
    }
    if (gen !== this.generation) return;
    this.buildRig();
    if (this.sim) {
      this.caseCtl = new CaseController(this.caseHost(), sc, c.sinusCl, this.siteIndex);
      this.uploadLeadFields();
    }
    this.post({ type: 'pacing', status: null });
    const stats = sub.stats();
    const info: SimInfo = {
      backend: c.mode === 'eikonal' ? 'eikonal' : this.backend!.kind,
      gpuError: this.gpuError,
      nV: this.tissue.geom.nV,
      dt,
      diffusionSubsteps: this.backend?.diffusionSubsteps ?? 0,
      D0: this.cal.D,
      cv: this.cal.cv,
      apd90: this.cal.apd90,
      fibroticFraction: stats.fibroticNodeFraction,
      removedEdgeFraction: stats.removedEdgeFraction,
      negativeCotEdges: this.tissue.geom.negativeCotEdges,
      buildMs: performance.now() - t0,
      eikonalMs,
    };
    this.post({ type: 'ready', info, config: { ...c }, rig: this.rigInfo(), scenario: sc?.info ?? null });
    this.postLesions();
    await this.postFrame(true);
  }

  /** Electrodes, lead fields and recording system for the current tissue. */
  private buildRig(): void {
    const mesh = this.mesh!;
    this.rig = new ElectrogramRig(mesh, this.sourceOptions(), this.config.seed, this.signals);
    this.rig.motionEnabled = this.motionEnabled;
    if (this.rovingVertex < 0 || this.rovingVertex >= mesh.region.length) this.rovingVertex = defaultRovingVertex(mesh);
    this.rig.placeRoving(this.rovingVertex, this.rovingConfig);
    this.egmChunks = [];
    this.displayIdx = this.rig.channels.map((c, i) => (c.display ? i : -1)).filter((i) => i >= 0);
    this.beats = new BeatExtractor({ fs: EGM_FS, nCh: this.rig.channels.length, refChannel: this.channelIndex(this.refName), preMs: 350, postMs: 350 });
    this.nextMotionT = this.now();
    this.eikNextSample = Math.ceil(this.now() / (1000 / EGM_FS)) * (1000 / EGM_FS);
    this.uploadLeadFields();
    if (!this.sim) this.buildEikonalTable();
  }

  private sampleEvery(): number {
    return Math.max(1, Math.round(1000 / EGM_FS / this.dt()));
  }

  private uploadLeadFields(): void {
    if (!this.sim || !this.rig) return;
    const probes = this.caseCtl?.probeRows() ?? [];
    this.probeVersion = this.caseCtl?.probes.version ?? -1;
    this.sim.backend.setLeadFields([...this.rig.rows(), ...probes], this.sampleEvery());
  }

  private channelIndex(name: string): number {
    const i = this.rig?.channels.findIndex((c) => c.name === name) ?? -1;
    return i >= 0 ? i : (this.rig?.channels.findIndex((c) => c.group === 'cs') ?? 0);
  }

  setReference(name: string): Promise<void> {
    return this.enqueue(async () => {
      this.refName = name;
      this.beats?.setReference(this.channelIndex(name));
    });
  }

  private rigInfo(): RigInfo {
    const r = this.rig!;
    const site = this.sites.find((x) => x.name === 'Fossa ovalis') ?? this.sites[0];
    const P = this.mesh!.positions, N = this.mesh!.normals;
    const v = site ? site.vertices[0]! : 0;
    return {
      channels: r.channels.filter((c) => c.display),
      fs: EGM_FS,
      csPath: r.cs.path.flat(),
      csElectrodes: r.cs.electrodes.flat(),
      // Entry point 3 mm inside the septal wall at the fossa.
      transseptal: [0, 1, 2].map((k) => P[3 * v + k]! - 3 * N[3 * v + k]!),
      esophagus: { path: this.esophagus?.path.flat() ?? [], radius: this.esophagus?.radius ?? 0 },
    };
  }

  placeRoving(vertex: number): Promise<void> {
    return this.enqueue(async () => {
      this.rovingVertex = vertex;
      if (!this.rig) return;
      this.rig.placeRoving(vertex, this.rovingConfig);
      this.uploadLeadFields();
      await this.postFrame(true);
    });
  }

  setRovingConfig(config: Partial<RovingConfig>): Promise<void> {
    return this.enqueue(async () => {
      this.rovingConfig = { ...this.rovingConfig, ...config };
      this.rig?.setRovingConfig(this.rovingConfig);
      this.uploadLeadFields();
      await this.postFrame(true);
    });
  }

  setSignals(settings: SignalSettings): Promise<void> {
    return this.enqueue(async () => {
      this.signals = settings;
      this.rig?.configureSignals(settings);
    });
  }

  setMotion(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.motionEnabled = enabled;
      if (this.rig) this.rig.motionEnabled = enabled;
    });
  }

  /** Steady-state eikonal Vm of vertex i at time t (normalized). */
  private eikVm(i: number, t: number): number {
    const T = this.eikonalT!, tpl = this.template!;
    const ti = T[i]!;
    if (!Number.isFinite(ti)) return 0;
    const cl = this.config.sinusCl;
    if (cl <= 0) return tpl.at(t - ti);
    const phase = ((t % cl) + cl) % cl;
    return Math.max(tpl.at(phase - ti), tpl.at(phase + cl - ti));
  }

  /**
   * Precompute one cycle of the non-moving electrodes (ECG, CS) in eikonal mode. Each vertex's
   * Vm depends on t only through t − T_i, so lead-field weights are binned by activation time
   * (linear split between neighbouring 0.5 ms bins) and every sample becomes a short dot product
   * over bins: φ_r(t) = Σ_k W_r[k] · Vm_k(t).
   */
  private buildEikonalTable(): void {
    if (!this.rig || !this.eikonalT || !this.template) return;
    const step = 1000 / EGM_FS;
    const cl = this.config.sinusCl > 0 ? this.config.sinusCl : 600;
    const len = Math.round(cl / step);
    const rows = this.rig.electrodes.map((e, i) => (e.group === 'ecg' || e.group === 'cs' ? i : -1)).filter((i) => i >= 0);
    const fields = this.rig.rows();
    const T = this.eikonalT;
    let tMax = 0;
    for (const t of T) if (Number.isFinite(t)) tMax = Math.max(tMax, t);
    const nBins = Math.ceil(tMax / step) + 2;
    const W = new Float64Array(rows.length * nBins);
    rows.forEach((r, j) => {
      const f = fields[r]!;
      for (let q = 0; q < f.idx.length; q++) {
        const ti = T[f.idx[q]!]!;
        if (!Number.isFinite(ti)) continue;
        const x = ti / step, k = Math.floor(x), a = x - k;
        W[j * nBins + k] += (1 - a) * f.w[q]!;
        W[j * nBins + k + 1] += a * f.w[q]!;
      }
    });
    const tpl = this.template, periodic = this.config.sinusCl > 0;
    const vm = new Float64Array(nBins);
    const data = new Float32Array(len * rows.length);
    for (let s = 0; s < len; s++) {
      const phase = s * step;
      for (let k = 0; k < nBins; k++) vm[k] = periodic ? Math.max(tpl.at(phase - k * step), tpl.at(phase + cl - k * step)) : tpl.at(phase - k * step);
      for (let j = 0; j < rows.length; j++) {
        let acc = 0;
        const o = j * nBins;
        for (let k = 0; k < nBins; k++) acc += W[o + k]! * vm[k]!;
        data[s * rows.length + j] = acc;
      }
    }
    this.eikTable = { data, len, rows };
  }

  /** Eikonal-mode samples in (from, to]: static rows from the periodic table, roving rows on the fly. */
  private eikonalSamples(from: number, to: number): EgmSamples | null {
    const rig = this.rig, tab = this.eikTable;
    if (!rig || !tab || !this.eikonalT) return null;
    const step = 1000 / EGM_FS;
    const times: number[] = [];
    for (let t = this.eikNextSample; t <= to + 1e-9; t += step) if (t > from - 1e-9) times.push(t);
    if (!times.length) return null;
    this.eikNextSample = times[times.length - 1]! + step;
    const nE = rig.electrodes.length;
    const data = new Float32Array(times.length * nE);
    const cl = this.config.sinusCl;
    const moving = this.movingFields();
    const vmU = new Float32Array(moving.union.length);
    times.forEach((t, s) => {
      const k = cl > 0 ? Math.round((((t % cl) + cl) % cl) / step) % tab.len : Math.min(tab.len - 1, Math.round(t / step));
      tab.rows.forEach((r, j) => (data[s * nE + r] = tab.data[k * tab.rows.length + j]!));
      // Each vertex in the union of the moving electrodes' supports is evaluated once per sample.
      for (let j = 0; j < moving.union.length; j++) vmU[j] = this.eikVm(moving.union[j]!, t);
      for (const m of moving.rows) {
        let acc = 0;
        for (let q = 0; q < m.pos.length; q++) acc += m.w[q]! * vmU[m.pos[q]!]!;
        data[s * nE + m.row] = acc;
      }
    });
    return { times: Float64Array.from(times), data, rows: nE };
  }

  private movingCache: { version: number; union: Uint32Array; rows: Array<{ row: number; pos: Uint32Array; w: Float32Array }> } | null = null;

  /** Lead fields of the moving (catheter) electrodes, re-indexed into the union of their supports. */
  private movingFields(): NonNullable<SimEngine['movingCache']> {
    const rig = this.rig!;
    if (this.movingCache?.version === rig.version) return this.movingCache;
    const fields = rig.rows();
    const rowsIdx = rig.electrodes.map((e, i) => (e.group === 'map' || e.group === 'grid' ? i : -1)).filter((i) => i >= 0 && fields[i]!.idx.length > 0);
    const where = new Map<number, number>();
    for (const r of rowsIdx) for (const v of fields[r]!.idx) if (!where.has(v)) where.set(v, where.size);
    const union = Uint32Array.from(where.keys());
    const rows = rowsIdx.map((r) => ({ row: r, pos: Uint32Array.from(fields[r]!.idx, (v) => where.get(v)!), w: fields[r]!.w }));
    this.movingCache = { version: rig.version, union, rows };
    return this.movingCache;
  }

  private collect(samples: EgmSamples | null): void {
    if (!samples || !this.rig || !samples.times.length) return;
    const p = this.rig.process(samples);
    if (!p.n) return;
    this.caseCtl?.onSignals(p, this.now());
    this.egmChunks.push(p);
    this.extractBeats(p);
    // Bound memory if nobody drains (e.g. frames throttled): keep ≤ 10 s.
    let total = this.egmChunks.reduce((a, c) => a + c.n, 0);
    while (total > 10 * EGM_FS && this.egmChunks.length > 1) total -= this.egmChunks.shift()!.n;
  }

  /**
   * Eikonal activation from the sinus breakthrough sites. Node speed = target CV × √σ (CV ∝ √D),
   * zero at fibrotic nodes; removed (interstitial) edges are approximated by a local slowing.
   */
  private computeEikonal(): Float32Array {
    const t = this.tissue!;
    const s = t.substrate;
    const g = t.geom;
    const removed = new Float32Array(g.nV), deg = new Float32Array(g.nV);
    for (let e = 0; e < g.edgeA.length; e++) {
      for (const v of [g.edgeA[e]!, g.edgeB[e]!]) {
        deg[v]!++;
        if (s.edgeScale[e] === 0) removed[v]!++;
      }
    }
    const exc = s.excitable();
    const cv = t.preset.targetCv;
    const speed = new Float32Array(g.nV);
    for (let i = 0; i < g.nV; i++) {
      if (!exc[i]) continue;
      const frac = deg[i]! > 0 ? removed[i]! / deg[i]! : 0;
      speed[i] = cv * Math.sqrt(s.conductivity[i]! * s.lesionConductivity[i]!) * Math.max(0.2, 1 - frac);
    }
    const sources = this.sites.flatMap((site) => Array.from(site.vertices, (v) => ({ vertex: v, t0: site.delay })));
    return fastMarching(g.positions, this.mesh!.indices, speed, sources);
  }

  private applySinus(): void {
    if (this.sim) this.caseCtl?.setSinusCl(this.config.sinusCl, this.sim.t);
  }

  play(): void {
    if (this.running) return;
    this.running = true;
    this.debt = 0;
    this.lastTick = performance.now();
    this.win = { wall0: this.lastTick, sim: 0 };
    void this.tick();
  }

  pause(): void {
    this.running = false;
    void this.postFrame(true);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  step(ms: number): Promise<void> {
    return this.enqueue(async () => {
      await this.advance(ms);
      await this.postFrame(true);
    });
  }

  reset(): Promise<void> {
    this.running = false;
    return this.enqueue(() => this.rebuild());
  }

  private lastTick = 0;

  /** Simulated ms per sub-chunk, adapted so one sub-chunk costs ~5–15 ms of wall time. */
  private subChunk = 1;
  /** Simulated time owed to the wall clock when a speed target is set. */
  private debt = 0;

  /**
   * One scheduler tick: spend up to ~30 ms of wall time advancing the simulation in sub-chunks,
   * then post a frame. With a speed target, only the simulated time owed (speed × elapsed wall
   * time, capped) is advanced; at "max" the whole budget is used.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.enqueue(async () => {
      const now = performance.now();
      const wall = Math.min(100, now - this.lastTick);
      this.lastTick = now;
      const eik = this.mode() === 'eikonal';
      // Eikonal playback costs nothing, so "max" means real time there.
      const speed = this.speed > 0 ? this.speed : eik ? 1 : 0;
      if (eik) {
        await this.advance(speed * wall);
        this.win.sim += speed * wall;
      } else {
        if (speed > 0) this.debt = Math.min(this.debt + speed * wall, 50);
        const budgetEnd = performance.now() + 30;
        while (performance.now() < budgetEnd && (speed === 0 || this.debt >= this.dt())) {
          const chunk = speed > 0 ? Math.min(this.subChunk, this.debt) : this.subChunk;
          const t0 = performance.now();
          await this.advance(chunk);
          const spent = performance.now() - t0;
          if (speed > 0) this.debt -= chunk;
          this.win.sim += chunk;
          if (spent < 5) this.subChunk = Math.min(this.subChunk * 2, 200);
          else if (spent > 15) this.subChunk = Math.max(this.subChunk / 2, this.dt());
        }
      }
      const winWall = performance.now() - this.win.wall0;
      if (winWall >= 500) {
        this.speedMeasured = this.win.sim / winWall;
        this.win = { wall0: performance.now(), sim: 0 };
      }
      await this.postFrame(false);
    });
    if (this.running) setTimeout(() => void this.tick(), this.speed > 0 ? 4 : 0);
  }

  private mode(): 'rd' | 'eikonal' {
    return this.sim ? 'rd' : 'eikonal';
  }

  private dt(): number {
    return this.sim?.dt ?? 0.5;
  }

  /**
   * Advance the clock by `ms`, in pieces aligned to the catheter-motion update interval so the
   * roving lead fields follow the moving tip, and collect electrogram samples.
   */
  private async advance(ms: number): Promise<void> {
    const end = this.now() + ms;
    const half = this.sim ? this.dt() / 2 : 1e-9;
    while (end - this.now() > half) {
      const now = this.now();
      if (this.rig && now >= this.nextMotionT - 1e-9) {
        if (this.rig.updateMotion(now, this.config.sinusCl)) this.uploadLeadFields();
        this.nextMotionT = (Math.floor(now / MOTION_UPDATE_MS + 1e-9) + 1) * MOTION_UPDATE_MS;
      }
      const piece = Math.min(end, this.rig ? this.nextMotionT : end) - now;
      this.stepAblation(now, piece);
      if (this.sim) {
        const cc = this.caseCtl;
        cc?.beforePiece(now, now + Math.max(piece, this.dt()));
        if (cc && cc.probes.version !== this.probeVersion) this.uploadLeadFields();
        await this.sim.advance(Math.max(piece, this.dt()));
        const raw = this.sim.backend.drainSamples();
        const nE = this.rig?.electrodes.length ?? raw.rows;
        if (cc && raw.rows > nE) cc.onProbeSamples(raw, nE);
        this.collect(stripRows(raw, nE));
      } else {
        this.collect(this.eikonalSamples(now, now + piece));
        this.eikT = now + piece;
      }
    }
  }

  private now(): number {
    return this.sim ? this.sim.t : this.eikT;
  }

  private async postFrame(force: boolean): Promise<void> {
    const wallNow = performance.now();
    if (!force && wallNow - this.lastFrame < 33) return;
    this.lastFrame = wallNow;
    let v: Float32Array;
    if (this.sim) v = await this.sim.backend.readV();
    else v = this.eikonalVm();
    const egm = this.drainEgm();
    const roving = this.rovingFrame();
    const rf = this.rfFrame();
    const stims = this.caseCtl?.stimsIn(this.lastFrameT, this.now()) ?? [];
    this.lastFrameT = this.now();
    this.post({ type: 'frame', t: this.now(), v, speed: this.speedMeasured, running: this.running, egm, roving, rf, stims }, egm ? [v.buffer, egm.data.buffer] : [v.buffer]);
  }

  /** Feed processed samples to the beat extractor and post completed reference beats. */
  private extractBeats(p: { t0: number; n: number; data: Float32Array }): void {
    const rig = this.rig, ex = this.beats;
    if (!rig || !ex) return;
    const mapping = rig.mappingElectrodes();
    const ii = rig.channels.findIndex((c) => c.name === 'II');
    const need = [ex.refChannel, ii, ...mapping.flatMap((m) => [m.uni, m.bip])];
    const slices = ex.push(p.t0, p.data, p.n, need);
    const r = rig.rovingState();
    if (!r) return;
    for (const s of slices) {
      const beat: BeatWindow = {
        refTime: s.refTime,
        cl: s.cl,
        fs: s.fs,
        preMs: s.preMs,
        refName: rig.channels[ex.refChannel]!.name,
        ref: s.data.get(ex.refChannel)!,
        ecg: s.data.get(ii)!,
        catheter: r.config.type,
        contactVertex: r.vertex,
        electrodes: mapping.map((m) => ({ name: m.name, position: [...(m.electrode === 0 && r.config.type === 'ablation' ? r.pose.tipEnd : r.pose.electrodes[m.electrode]!)], uni: s.data.get(m.uni)!, bip: s.data.get(m.bip)! })),
        force: r.pose.force,
        stability: r.stability,
      };
      const transfer = [beat.ref.buffer, beat.ecg.buffer, ...beat.electrodes.flatMap((e) => [e.uni.buffer, e.bip.buffer])];
      this.post({ type: 'beat', beat }, [...new Set(transfer)] as Transferable[]);
    }
  }

  private drainEgm(): EgmChunk | null {
    if (!this.egmChunks.length || !this.rig) return null;
    const all = this.rig.channels.length;
    const sel = this.displayIdx;
    const nCh = sel.length;
    const n = this.egmChunks.reduce((a, c) => a + c.n, 0);
    const data = new Float32Array(n * nCh);
    let off = 0;
    for (const c of this.egmChunks) {
      for (let s = 0; s < c.n; s++) for (let j = 0; j < nCh; j++) data[off + s * nCh + j] = c.data[s * all + sel[j]!]!;
      off += c.n * nCh;
    }
    const t0 = this.egmChunks[0]!.t0;
    this.egmChunks = [];
    return { t0, n, nCh, data };
  }

  private rovingFrame(): RovingFrame | null {
    const r = this.rig?.rovingState();
    if (!r) return null;
    return {
      vertex: r.vertex,
      config: r.config,
      electrodes: r.pose.electrodes.flat(),
      tipEnd: [...r.pose.tipEnd],
      axis: [...r.pose.axis],
      contact: [...r.pose.contact],
      normal: [...r.pose.normal],
      force: r.pose.force,
      gap: r.pose.gap,
      stability: r.stability,
    };
  }

  /** Vm (normalized) in eikonal mode: template(t − T_i) for the current and previous sinus beat. */
  private eikonalVm(): Float32Array {
    const T = this.eikonalT, tpl = this.template;
    const n = this.tissue?.geom.nV ?? 0;
    const out = new Float32Array(n);
    if (!T || !tpl) return out;
    const cl = this.config.sinusCl;
    const t = this.eikT;
    const phase = cl > 0 ? t % cl : t;
    for (let i = 0; i < n; i++) {
      const ti = T[i]!;
      if (!Number.isFinite(ti)) continue;
      let v = tpl.at(phase - ti);
      if (cl > 0 && t >= cl) v = Math.max(v, tpl.at(phase + cl - ti));
      out[i] = v;
    }
    return out;
  }

  requestActivation(): Promise<void> {
    return this.enqueue(async () => {
      const n = this.tissue?.geom.nV ?? 0;
      let last: Float32Array;
      let beatStart = 0;
      if (this.sim) {
        const a = await this.sim.activation();
        last = a.last;
        // Express the most recent beat relative to its earliest activation.
        let min = Infinity, max = -Infinity;
        for (const x of last) if (Number.isFinite(x)) { min = Math.min(min, x); max = Math.max(max, x); }
        beatStart = Number.isFinite(min) ? min : 0;
        if (this.config.sinusCl > 0 && max - min > this.config.sinusCl) beatStart = max - this.config.sinusCl;
      } else {
        last = this.eikonalT ? this.eikonalT.slice() : new Float32Array(n).fill(-Infinity);
      }
      const fibrotic = this.tissue ? this.tissue.substrate.fibroticNode.slice() : new Uint8Array(n);
      const lesion = this.lesionKind?.slice() ?? new Uint8Array(n);
      this.post({ type: 'activation', t: this.now(), last, beatStart, fibrotic, lesion }, [last.buffer, fibrotic.buffer, lesion.buffer]);
    });
  }

  // ---- Ablation -------------------------------------------------------------------------------

  private sourceOptions() {
    const sub = this.tissue!.substrate;
    return { thickness: this.mesh!.wallThickness, fibrosisDepth: sub.fibrosisDepth, excitable: sub.excitable(), sourceScale: this.lesionSource ?? undefined };
  }

  /** Rasterize the lesion set into the substrate (no solver/rig update). */
  private rasterizeLesions(now: number): void {
    if (!this.ablation || !this.tissue) return;
    const f = this.ablation.rasterize(now);
    applyLesionsToSubstrate(this.tissue.substrate, f);
    this.lesionSource = f.source;
    this.lesionKind = f.kind;
    this.edemaCheckT = this.ablation.nextEdemaExpiry(now);
  }

  private edemaCheckT = Infinity;

  /**
   * Re-rasterize lesions and push the changed tissue everywhere it is used: solver diffusivities
   * and excitability (reaction–diffusion), the eikonal map, and the EGM lead fields.
   */
  private applyLesions(): void {
    if (!this.tissue || !this.cal) return;
    const now = this.now();
    this.rasterizeLesions(now);
    const sub = this.tissue.substrate;
    if (this.sim) {
      this.sim.backend.setEdgeDiffusivity(this.edgeD());
      this.sim.backend.setVertexParams(sub.apdScale, sub.excitable());
      this.caseCtl?.updateSources();
      this.caseCtl?.updateFootprint();
    } else {
      this.eikonalT = this.computeEikonal();
    }
    if (this.rig) {
      this.rig.updateSources(this.sourceOptions());
      this.uploadLeadFields();
      if (!this.sim) this.buildEikonalTable();
    }
    this.postLesions();
  }

  private postLesions(): void {
    if (!this.ablation || !this.lesionKind || !this.esophagus) return;
    const kind = this.lesionKind.slice(), zone = this.esophagus.zone.slice();
    this.post({ type: 'lesions', lesions: this.ablation.lesions.map((l) => ({ ...l, center: [...l.center] })), kind, esophagealZone: zone }, [kind.buffer, zone.buffer]);
  }

  /** Advance an active RF application over `piece` ms of simulated time; handle edema expiry. */
  private stepAblation(now: number, piece: number): void {
    const a = this.ablation, rig = this.rig;
    if (!a || !rig) return;
    if (a.active) {
      const r = rig.rovingState();
      if (!r || r.config.type !== 'ablation' || r.vertex !== this.rfVertex) {
        a.stop(now);
        this.applyLesions();
      } else {
        const res = a.step((piece / 1000) * this.ablationSettings.timeScale, r.pose.force, now + piece);
        // Reaction–diffusion follows the growing lesion; the eikonal map is recomputed when RF ends.
        if (res?.changed && (this.sim || !a.active)) this.applyLesions();
      }
    }
    if (now >= this.edemaCheckT) this.applyLesions();
  }

  setAblationSettings(settings: AblationSettings): void {
    this.ablationSettings = { ...settings };
  }

  /** Start RF at the roving catheter tip; `instant` delivers the whole application at once. */
  rfStart(instant: boolean): Promise<void> {
    return this.enqueue(async () => {
      const a = this.ablation, r = this.rig?.rovingState();
      if (!a || !r) return;
      if (r.config.type !== 'ablation') throw new Error('Only the ablation catheter can deliver RF.');
      this.rfVertex = r.vertex;
      if (instant) {
        a.deliver(r.vertex, r.pose.contact, this.ablationSettings, r.config.force, this.now());
        this.applyLesions();
      } else {
        a.start(r.vertex, r.pose.contact, this.ablationSettings, this.now());
        this.postLesions();
      }
      await this.postFrame(true);
    });
  }

  rfStop(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.ablation?.active) return;
      this.ablation.stop(this.now());
      this.applyLesions();
      await this.postFrame(true);
    });
  }

  resetLesions(): Promise<void> {
    return this.enqueue(async () => {
      this.ablation?.reset();
      this.applyLesions();
      await this.postFrame(true);
    });
  }

  private rfFrame(): RfFrame | null {
    const a = this.ablation;
    const r = a?.readout();
    if (!a || !r) return null;
    const L = a.lesions[a.lesions.length - 1]!;
    return { ...r, lesionId: L.id, inEsophagealZone: this.esophagus?.zone[L.vertex] === 1 };
  }

  // ---- Case: pacing, cardioversion, report --------------------------------------------------------

  private siteIndex = { sinus: [] as number[], pace: -1, sources: [] as number[], induction: -1 };

  /** Edge diffusivities of the current substrate, with any transient induction block applied. */
  private edgeD(): Float32Array {
    const e = this.tissue!.substrate.edgeDiffusivity(this.cal!.D);
    const b = this.transientBlock;
    if (b) {
      const set = new Uint8Array(this.tissue!.geom.nV);
      for (const v of b) set[v] = 1;
      const g = this.tissue!.geom;
      for (let k = 0; k < e.length; k++) if (set[g.edgeA[k]!] || set[g.edgeB[k]!]) e[k] = 0;
    }
    return e;
  }

  private setTransientBlock(v: Uint32Array | null): void {
    this.transientBlock = v;
    this.sim?.backend.setEdgeDiffusivity(this.edgeD());
  }

  private caseHost(): CaseHost {
    const self = this;
    return {
      get mesh() { return self.mesh!; },
      get sim() { return self.sim!; },
      get rig() { return self.rig!; },
      get substrate() { return self.tissue!.substrate; },
      get geom() { return self.tissue!.geom; },
      get D0() { return self.cal!.D; },
      get apd90() { return self.cal!.apd90; },
      get sinusSites() { return self.sites; },
      get ablation() { return self.ablation!; },
      get esophagealZone() { return self.esophagus!.zone; },
      lesionSource: () => self.lesionSource,
      setTransientBlock: (v) => self.setTransientBlock(v),
      refChannel: () => self.beats?.refChannel ?? 0,
      setReference: (name) => {
        self.refName = name;
        self.beats?.setReference(self.channelIndex(name));
        self.post({ type: 'reference', name });
      },
      post: (m) => self.post(m),
    };
  }

  pace(request: PacingRequest): Promise<void> {
    return this.enqueue(async () => {
      if (!this.caseCtl || !this.sim) throw new Error('Pacing needs the reaction–diffusion engine (Simulation panel).');
      this.caseCtl.startPacing(request, this.sim.t);
    });
  }

  paceStop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.sim) this.caseCtl?.stopPacing(this.sim.t);
    });
  }

  /** DC cardioversion: reset every cell to rest. */
  cardiovert(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sim || !this.caseCtl) return;
      const model = createIonicModel(this.ionic);
      const [v0, g0, g1] = model.restState();
      const n = this.sim.backend.nV;
      await this.caseCtl.cardiovert(this.sim.t, () => this.sim!.backend.setState(new Float32Array(n).fill(v0), new Float32Array(n).fill(g0), new Float32Array(n).fill(g1)));
      await this.postFrame(true);
    });
  }

  requestReport(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.tissue || !this.ablation || !this.mesh || !this.cal || !this.esophagus) return;
      const now = this.now();
      const report = this.caseCtl
        ? this.caseCtl.report(now, this.config.sinusCl)
        : caseGroundTruth(
            { mesh: this.mesh, substrate: this.tissue.substrate, geom: this.tissue.geom, D0: this.cal.D, sinusSites: this.sites, ablation: this.ablation, esophagealZone: this.esophagus.zone },
            this.scenario, now, performance.now() - this.caseWall0,
            { rhythm: 'sinus', inductions: 0, cardioversions: 0, pacingLog: [], sources: this.scenario?.sources ?? [] },
          );
      report.wallMs = performance.now() - this.caseWall0;
      this.post({ type: 'report', report });
    });
  }

  runLab(): Promise<void> {
    return this.enqueue(async () => {
      const preset = PRESETS[this.config.preset];
      const model = createIonicModel(this.ionic);
      const dt = model.recommendedDt;
      const h = this.tissue?.geom.meanEdge ?? 0.955;
      const cal = this.cal ?? (await calibrateDiffusivity(this.ionic, preset.targetCv, { h, dt }));
      this.post({ type: 'status', message: 'Measuring S1–S2 restitution…' });
      const restitution = await measureRestitution(this.ionic, cal.D, { h, dt, step: 10 });
      this.post({ type: 'lab', preset: this.config.preset, ionic: this.config.ionic, D0: cal.D, cv: cal.cv, apd90: cal.apd90, restitution });
    });
  }
}

/** Default roving position: the lateral-wall vertex closest to that region's centroid. */
function defaultRovingVertex(mesh: SurfaceMesh): number {
  const P = mesh.positions;
  const c = [0, 0, 0];
  let n = 0;
  mesh.region.forEach((r, i) => {
    if (r !== Region.Lateral) return;
    for (let k = 0; k < 3; k++) c[k]! += P[3 * i + k]!;
    n++;
  });
  if (!n) return 0;
  let best = 0, bd = Infinity;
  mesh.region.forEach((r, i) => {
    if (r !== Region.Lateral) return;
    const d = (P[3 * i]! - c[0]! / n) ** 2 + (P[3 * i + 1]! - c[1]! / n) ** 2 + (P[3 * i + 2]! - c[2]! / n) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Drop solver rows beyond the rig's electrodes (probe columns). */
function stripRows(s: EgmSamples, nE: number): EgmSamples {
  if (s.rows <= nE) return s;
  const n = s.times.length;
  const data = new Float32Array(n * nE);
  for (let k = 0; k < n; k++) data.set(s.data.subarray(k * s.rows, k * s.rows + nE), k * nE);
  return { times: s.times, data, rows: nE };
}
