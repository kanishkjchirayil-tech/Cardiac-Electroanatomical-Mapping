import type { Vec3 } from '../math/vec3';
import type { SpatialGrid } from '../mesh/spatial';

/**
 * Pacing capture model (MODEL.md §6.1), phenomenological. Current density from a small cathode
 * falls roughly as 1/r², so the threshold rises with the electrode–tissue gap d:
 *
 *   I_th(d) = I₀ · (1 + (d / d₀)²) / viable        I₀ = 0.4 mA, d₀ = 1 mm (2 ms pulse)
 *
 * `viable` is the mean excitable, viable-myocardium fraction under the electrode (lesion cores,
 * fibrotic nodes and partial-thickness lesions raise the threshold; dense scar does not capture).
 * Above threshold the stimulated ("virtual electrode") region grows with output,
 * r = r₀ · √(I / I_th) (r₀ = 1.5 mm, ≤ 5 mm), and the injected current scales as √(I / I_th) so a
 * strong output captures earlier in the relative refractory period. Whether a stimulus actually
 * propagates is then decided by the tissue state (refractoriness) in the solver.
 */
export const CAPTURE = {
  i0: 0.4,
  d0: 1,
  r0: 1.5,
  rMax: 5,
  /** Stimulus amplitude (normalized Δv/dt) at threshold; the pulse lasts `pulseMs`. */
  amp0: 0.5,
  pulseMs: 2,
};

export interface CaptureFootprint {
  /** Above threshold (tissue may still be refractory). */
  aboveThreshold: boolean;
  threshold: number;
  gap: number;
  viable: number;
  vertices: Uint32Array;
  amplitude: number;
  /** Vertex closest to the electrode (capture probe). */
  nearest: number;
}

/**
 * Stimulated vertices for a cathode at `p` with `output` mA. `gap` is the electrode-surface to
 * tissue distance (mm); when omitted it is the distance to the nearest vertex.
 * `viable(v)` gives each vertex's viable fraction (0 = scar/core, 1 = healthy).
 */
export function captureFootprint(grid: SpatialGrid, positions: Float32Array, p: Vec3, output: number, viable: (v: number) => number, gap?: number): CaptureFootprint {
  const near = grid.nearest(p);
  const d = Math.max(0, gap ?? near.distance);
  const probeR = CAPTURE.r0;
  const around: number[] = [];
  const centre = positions.subarray(3 * near.index, 3 * near.index + 3);
  grid.within(centre, probeR, around);
  const list = around.length ? around : [near.index];
  const via = list.reduce((a, v) => a + viable(v), 0) / list.length;
  const threshold = (CAPTURE.i0 * (1 + (d / CAPTURE.d0) ** 2)) / Math.max(0.02, via);
  const ratio = output / threshold;
  if (ratio < 1 || via < 0.02) return { aboveThreshold: false, threshold, gap: d, viable: via, vertices: new Uint32Array(0), amplitude: 0, nearest: near.index };
  const r = Math.min(CAPTURE.rMax, CAPTURE.r0 * Math.sqrt(ratio));
  const verts: number[] = [];
  grid.within(centre, r, verts);
  const vs = verts.filter((v) => viable(v) > 0);
  return {
    aboveThreshold: true,
    threshold,
    gap: d,
    viable: via,
    vertices: Uint32Array.from(vs.length ? vs : [near.index]),
    amplitude: CAPTURE.amp0 * Math.min(3, Math.sqrt(ratio)),
    nearest: near.index,
  };
}
