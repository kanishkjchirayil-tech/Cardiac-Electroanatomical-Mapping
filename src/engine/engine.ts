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
import { DEFAULT_SIM_CONFIG, type FromWorker, type SimConfig, type SimInfo } from './protocol';

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

  constructor(private readonly post: (msg: FromWorker, transfer?: Transferable[]) => void) {}

  /** Serialize all mutating operations so a rebuild never overlaps a running step. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(fn).catch((e) => this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
    return this.busy;
  }

  init(mesh: SurfaceMesh, config: SimConfig): Promise<void> {
    this.mesh = mesh;
    this.config = { ...config };
    return this.enqueue(() => this.rebuild());
  }

  configure(patch: Partial<SimConfig>): Promise<void> {
    const prev = this.config;
    this.config = { ...prev, ...patch };
    const onlySinus = Object.keys(patch).every((k) => k === 'sinusCl');
    if (onlySinus) return this.enqueue(async () => this.applySinus());
    return this.enqueue(() => this.rebuild());
  }

  private async rebuild(): Promise<void> {
    if (!this.mesh) return;
    const gen = ++this.generation;
    const t0 = performance.now();
    const c = this.config;
    const preset = PRESETS[c.preset];
    this.ionic = c.ionic === 'ms' ? preset.ionic : { id: c.ionic };
    const model = createIonicModel(this.ionic);
    this.post({ type: 'status', message: 'Building tissue…' });
    this.tissue = buildTissue(this.mesh, { ...preset, fibrosis: { ...preset.fibrosis, pattern: c.fibrosisPattern } }, c.seed, c.fibrosisScale);
    this.post({ type: 'status', message: 'Calibrating conduction velocity…' });
    const dt = model.recommendedDt;
    this.cal = await calibrateDiffusivity(this.ionic, preset.targetCv, { h: this.tissue.geom.meanEdge, dt });
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
      this.sites.forEach((s) => this.sim!.schedule.addSite({ name: s.name, vertices: s.vertices, amplitude: 0.5, duration: 2 }));
      this.sim.markSitesChanged();
      this.applySinus();
    }
    if (gen !== this.generation) return;
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
    this.post({ type: 'ready', info, config: { ...c } });
    await this.postFrame(true);
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
    if (!this.sim) return;
    const cl = this.config.sinusCl;
    const start = this.sim.t + 1;
    this.sim.schedule.trains = cl > 0 ? this.sites.map((s, k) => ({ site: k, start: start + s.delay, period: cl, count: Infinity })) : [];
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
        this.eikT += speed * wall;
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

  private async advance(ms: number): Promise<void> {
    if (this.sim) await this.sim.advance(ms);
    else this.eikT += ms;
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
    this.post({ type: 'frame', t: this.now(), v, speed: this.speedMeasured, running: this.running }, [v.buffer]);
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
      const fibrotic = this.tissue ? Uint8Array.from(this.tissue.substrate.excitable(), (e) => 1 - e) : new Uint8Array(n);
      this.post({ type: 'activation', t: this.now(), last, beatStart, fibrotic }, [last.buffer, fibrotic.buffer]);
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
