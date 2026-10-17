import type { SolverBackend, ActivationRecord } from './backend';
import { MAX_STIM_SITES, StimulusSchedule } from './stimulus';

/**
 * Backend-agnostic simulation driver: owns the simulation clock and the stimulus schedule,
 * converts the schedule into per-step amplitudes and advances the backend in batches.
 * The clock is pure simulation time; wall-clock pacing is the caller's job (see engine worker).
 */
export class Simulation {
  t = 0;
  readonly schedule = new StimulusSchedule();
  private ampBuf = new Float32Array(0);
  private siteMapDirty = true;

  constructor(readonly backend: SolverBackend, readonly dt: number) {}

  /** Call after adding sites to the schedule. */
  markSitesChanged(): void {
    this.siteMapDirty = true;
  }

  /** Advance by `ms` of simulation time (rounded to whole steps). */
  async advance(ms: number, batch = 200): Promise<void> {
    let steps = Math.round(ms / this.dt);
    if (this.siteMapDirty) {
      this.backend.setSiteMap(this.schedule.siteMap(this.backend.nV));
      this.siteMapDirty = false;
    }
    while (steps > 0) {
      const n = Math.min(batch, steps);
      if (this.ampBuf.length < n * MAX_STIM_SITES) this.ampBuf = new Float32Array(n * MAX_STIM_SITES);
      const tmp = new Float32Array(MAX_STIM_SITES);
      for (let s = 0; s < n; s++) {
        // Amplitude sampled at the step midpoint.
        this.schedule.amplitudes(this.t + (s + 0.5) * this.dt, tmp);
        this.ampBuf.set(tmp, s * MAX_STIM_SITES);
      }
      await this.backend.step(n, this.t, this.ampBuf);
      this.t += n * this.dt;
      steps -= n;
    }
    this.schedule.prune(this.t);
  }

  activation(): ActivationRecord | Promise<ActivationRecord> {
    return this.backend.readActivation();
  }
}
