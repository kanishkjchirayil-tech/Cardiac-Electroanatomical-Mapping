/**
 * Pacing protocols (MODEL.md §6.1) expressed as stimulus times. All times in ms of simulated time.
 *  - fixed:  continuous (or N-beat) pacing at a cycle length;
 *  - burst:  N beats at a short cycle length (induction);
 *  - s1s2:   N S1 beats at S1, then a premature S2 (and optional S3) at the given coupling intervals;
 *  - entrain: N beats at a cycle length slightly shorter than the tachycardia, followed by a
 *            post-pacing-interval measurement.
 */
export type PacingProtocol =
  | { kind: 'fixed'; cl: number; count: number }
  | { kind: 'burst'; cl: number; count: number }
  | { kind: 's1s2'; s1: number; n: number; s2: number; s3?: number }
  | { kind: 'entrain'; cl: number; count: number };

export type PacingSite = 'roving' | 'cs-distal' | 'cs-proximal';

export interface PacingRequest {
  site: PacingSite;
  /** Output, mA (2 ms pulse). */
  output: number;
  protocol: PacingProtocol;
}

export const DEFAULT_PACING: PacingRequest = { site: 'cs-distal', output: 5, protocol: { kind: 'fixed', cl: 600, count: Infinity } };

/** Stimulus trains ({start, period, count}) for a protocol started at t0. */
export function protocolTrains(p: PacingProtocol, t0: number): Array<{ start: number; period: number; count: number }> {
  switch (p.kind) {
    case 'fixed':
    case 'burst':
    case 'entrain':
      return [{ start: t0, period: p.cl, count: p.count }];
    case 's1s2': {
      const lastS1 = t0 + (p.n - 1) * p.s1;
      const out = [{ start: t0, period: p.s1, count: p.n }, { start: lastS1 + p.s2, period: Infinity, count: 1 }];
      if (p.s3) out.push({ start: lastS1 + p.s2 + p.s3, period: Infinity, count: 1 });
      return out;
    }
  }
}

/** All stimulus times of a finite protocol (Infinity-count trains are truncated at `horizon`). */
export function protocolTimes(p: PacingProtocol, t0: number, horizon = t0 + 60_000): number[] {
  const out: number[] = [];
  for (const tr of protocolTrains(p, t0)) {
    for (let k = 0; k < tr.count; k++) {
      const t = tr.start + k * (Number.isFinite(tr.period) ? tr.period : 0);
      if (t > horizon) break;
      out.push(t);
      if (!Number.isFinite(tr.period)) break;
    }
  }
  return out.sort((a, b) => a - b);
}

/** End time of a protocol (last stimulus), Infinity for continuous pacing. */
export function protocolEnd(p: PacingProtocol, t0: number): number {
  const trains = protocolTrains(p, t0);
  return Math.max(...trains.map((t) => (Number.isFinite(t.count) ? t.start + (t.count - 1) * (Number.isFinite(t.period) ? t.period : 0) : Infinity)));
}
