import type { Simulation } from '../core/ep/simulation';
import type { LeadField } from '../core/signals/leadfield';
import type { EgmSamples } from '../core/ep/backend';
import type { SourceSpec, Induction } from '../core/scenarios/scenarios';
import { protocolEnd, protocolTrains, type PacingRequest } from '../core/pacing/protocols';
import { Rng } from '../core/rng';

/**
 * Rhythm drivers for the reaction–diffusion engine (MODEL.md §6.1–6.2). They schedule stimulus
 * trains on the Simulation and react to activation events from "probes": internal lead-field rows
 * of weight 1 at single vertices, which read the transmembrane potential at 2 kHz along with the
 * electrograms. Probes are hidden-state sensors used only by the drivers and for ground truth;
 * they are never part of the recorded signals.
 */
export class Probes {
  readonly names: string[] = [];
  readonly vertices: number[] = [];
  private last: number[] = [];
  private lastT: number[] = [];
  version = 0;

  set(name: string, vertex: number): void {
    const i = this.names.indexOf(name);
    if (i >= 0 && this.vertices[i] === vertex) return;
    if (i >= 0) { this.vertices[i] = vertex; this.last[i] = 0; this.lastT[i] = -Infinity; }
    else { this.names.push(name); this.vertices.push(vertex); this.last.push(0); this.lastT.push(-Infinity); }
    this.version++;
  }

  rows(): LeadField[] {
    return this.vertices.map((v) => ({ idx: Uint32Array.of(v), w: Float32Array.of(1) }));
  }

  /** Upstrokes (v crossing 0.5 upwards, ≥ 50 ms apart) in probe columns starting at `offset`. */
  scan(s: EgmSamples, offset: number): Array<{ name: string; t: number }> {
    const out: Array<{ name: string; t: number }> = [];
    const n = s.times.length;
    for (let p = 0; p < this.names.length; p++) {
      let prev = this.last[p]!;
      for (let k = 0; k < n; k++) {
        const v = s.data[k * s.rows + offset + p]!;
        const t = s.times[k]!;
        if (prev < 0.5 && v >= 0.5 && t - this.lastT[p]! > 50) {
          out.push({ name: this.names[p]!, t });
          this.lastT[p] = t;
        }
        prev = v;
      }
      this.last[p] = prev;
    }
    return out.sort((a, b) => a.t - b.t);
  }
}

/** Activation event at a driver's probe: own (caused by its stimulus) or foreign. */
export interface DriverEvent {
  t: number;
  own: boolean;
}

/**
 * Sinus input with reset: the next sinus beat is due one cycle after the last activation of the
 * Bachmann-bundle site, whatever caused it. A faster rhythm (tachycardia, pacing) therefore
 * suppresses sinus beats (overdrive), and sinus rhythm resumes after it stops.
 */
export class SinusDriver {
  next = 1;
  lastFire = -Infinity;
  readonly events: DriverEvent[] = [];

  constructor(private readonly sim: Simulation, private readonly sites: Array<{ index: number; delay: number }>, public cl: number) {}

  restart(t: number): void {
    this.next = t;
    this.sim.schedule.trains = this.sim.schedule.trains.filter((tr) => !this.sites.some((s) => s.index === tr.site));
  }

  /** Push the beats due before `end`. */
  schedule(end: number): void {
    if (this.cl <= 0) return;
    while (this.next <= end) {
      for (const s of this.sites) this.sim.schedule.trains.push({ site: s.index, start: this.next + s.delay, period: Infinity, count: 1 });
      this.lastFire = this.next;
      this.next += this.cl;
    }
  }

  onActivation(t: number): void {
    const own = t - this.lastFire > -1 && t - this.lastFire < 40;
    this.events.push({ t, own });
    if (this.events.length > 50) this.events.shift();
    if (!own && this.cl > 0) this.next = Math.max(this.next, t + this.cl);
  }

  /** The last `n` BB activations were all sinus beats. */
  inSinus(n = 2): boolean {
    const e = this.events.slice(-n);
    return e.length === n && e.every((x) => x.own);
  }
}

/** An ectopic source: automatic (reset like the sinus node) or intermittently triggered bursts. */
export class SourceDriver {
  active = true;
  private next: number;
  private lastFire = -Infinity;

  constructor(private readonly sim: Simulation, readonly index: number, readonly spec: SourceSpec, private readonly rng: Rng, start: number) {
    this.next = start + (spec.mode === 'automatic' ? rng.uniform(50, spec.cl) : rng.uniform(800, 2500));
  }

  schedule(end: number): void {
    if (!this.active) return;
    const s = this.spec;
    while (this.next <= end) {
      if (s.mode === 'automatic') {
        this.sim.schedule.trains.push({ site: this.index, start: this.next, period: Infinity, count: 1 });
        this.lastFire = this.next;
        this.next += s.cl;
      } else {
        const beats = this.rng.int(s.beats[0], s.beats[1] + 1);
        const cl = this.rng.uniform(s.cl[0], s.cl[1]);
        this.sim.schedule.trains.push({ site: this.index, start: this.next, period: cl, count: beats });
        this.lastFire = this.next + (beats - 1) * cl;
        this.next = this.lastFire + this.rng.uniform(s.interval[0], s.interval[1]);
      }
    }
  }

  onActivation(t: number): void {
    if (this.spec.mode !== 'automatic') return;
    const own = t - this.lastFire > -1 && t - this.lastFire < 30;
    if (!own) this.next = Math.max(this.next, t + this.spec.cl);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!on) this.sim.schedule.trains = this.sim.schedule.trains.filter((tr) => tr.site !== this.index);
  }
}

/** Pacing delivery: protocol trains on the pacing site; the footprint is updated by the engine. */
export class PacingDriver {
  req: PacingRequest | null = null;
  t0 = 0;
  end = -Infinity;
  /** Ordinal of the next stimulus to be reported to analysis. */
  private reported = 0;

  constructor(private readonly sim: Simulation, readonly index: number) {}

  start(req: PacingRequest, now: number): void {
    this.stop();
    this.req = req;
    this.t0 = now + 2;
    this.end = protocolEnd(req.protocol, this.t0);
    this.reported = 0;
    for (const tr of protocolTrains(req.protocol, this.t0)) this.sim.schedule.trains.push({ site: this.index, ...tr });
  }

  stop(): void {
    this.sim.schedule.trains = this.sim.schedule.trains.filter((tr) => tr.site !== this.index);
    if (this.req) this.end = Math.min(this.end, this.sim.t);
    this.req = null;
  }

  active(now: number): boolean {
    return !!this.req && now <= this.end + 1;
  }

  /** Stimulus times in (a, b]. */
  stimsIn(a: number, b: number): number[] {
    const out: number[] = [];
    if (!this.req) return out;
    for (const tr of protocolTrains(this.req.protocol, this.t0)) {
      for (let k = 0; k < tr.count; k++) {
        const t = tr.start + k * (Number.isFinite(tr.period) ? tr.period : 0);
        if (t > b) break;
        if (t > a) out.push(t);
        if (!Number.isFinite(tr.period)) break;
      }
    }
    return out.sort((x, y) => x - y);
  }

  /** All stimuli delivered so far (finite list, bounded to the last 64). */
  delivered(now: number): number[] {
    return this.stimsIn(Math.max(this.t0 - 1, now - 64 * 1000), Math.min(now, this.end)).slice(-64);
  }

  get reportedCount(): number {
    return this.reported;
  }

  set reportedCount(n: number) {
    this.reported = n;
  }
}

/** Scripted induction: transient line block with a stimulus beside it, or a cross-field S2. */
export class InductionDriver {
  count = 0;
  private pending: Array<{ at: number; run: () => void }> = [];

  constructor(
    private readonly sim: Simulation,
    readonly index: number,
    readonly spec: Induction[],
    private readonly hooks: { block: (v: Uint32Array | null) => void; apd: number },
  ) {}

  /** Arm the induction so it starts at `t0` (the S1 for cross-field is the sinus beat at t0). */
  arm(t0: number): void {
    this.count++;
    for (const ind of this.spec) {
      if (ind.kind === 'line') {
        const site = this.sim.schedule.sites[this.index]!;
        site.vertices = ind.stim;
        this.sim.markSitesChanged();
        this.pending.push({ at: t0 + ind.at - 1, run: () => this.hooks.block(ind.block) });
        this.sim.schedule.trains.push({ site: this.index, start: t0 + ind.at, period: Infinity, count: 1 });
        this.pending.push({ at: t0 + ind.release, run: () => this.hooks.block(null) });
      } else {
        const site = this.sim.schedule.sites[this.index]!;
        site.vertices = ind.s2;
        site.amplitude = 1;
        this.sim.markSitesChanged();
        this.sim.schedule.trains.push({ site: this.index, start: t0 + ind.s2Base + this.hooks.apd, period: Infinity, count: 1 });
      }
    }
  }

  /** Run actions due before `end`. */
  step(end: number): void {
    const due = this.pending.filter((p) => p.at <= end);
    this.pending = this.pending.filter((p) => p.at > end);
    for (const p of due) p.run();
  }

  get busy(): boolean {
    return this.pending.length > 0;
  }
}
