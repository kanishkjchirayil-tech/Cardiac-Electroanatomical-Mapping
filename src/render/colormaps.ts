import { REGIONS } from '../core/mesh/regions';

export type RGB = [number, number, number];

/** Viridis approximation (polynomial fit, public-domain coefficients by Matt Zucker). t ∈ [0,1]. */
export function viridis(t: number): RGB {
  const x = Math.min(1, Math.max(0, t));
  const c0 = [0.2777273272234177, 0.005407344544966578, 0.3340998053353061];
  const c1 = [0.1050930431085774, 1.404613529898575, 1.384590162594685];
  const c2 = [-0.3308618287255563, 0.214847559468213, 0.09509516302823659];
  const c3 = [-4.634230498983486, -5.799100973351585, -19.33244095627987];
  const c4 = [6.228269936347081, 14.17993336680509, 56.69055260068105];
  const c5 = [4.776384997670288, -13.74514537774601, -65.35303263337234];
  const c6 = [-5.435455855934631, 4.645852612178535, 26.3124352495832];
  const out: number[] = [];
  for (let k = 0; k < 3; k++) {
    out.push(c0[k]! + x * (c1[k]! + x * (c2[k]! + x * (c3[k]! + x * (c4[k]! + x * (c5[k]! + x * c6[k]!))))));
  }
  return [out[0]!, out[1]!, out[2]!];
}

/** sRGB → linear (three.js vertex colours are interpreted as linear). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fill(n: number, f: (v: number) => RGB): Float32Array {
  const out = new Float32Array(3 * n);
  for (let v = 0; v < n; v++) {
    const c = f(v);
    out[3 * v] = srgbToLinear(c[0]);
    out[3 * v + 1] = srgbToLinear(c[1]);
    out[3 * v + 2] = srgbToLinear(c[2]);
  }
  return out;
}

export const SHELL_COLOR: RGB = [0.78, 0.66, 0.62];

export function shellColors(n: number): Float32Array {
  return fill(n, () => SHELL_COLOR);
}

export function regionColors(region: Uint8Array, highlight: number | null = null): Float32Array {
  return fill(region.length, (v) => {
    const r = region[v]!;
    const c = REGIONS[r]?.color ?? REGIONS[0]!.color;
    if (highlight === null || highlight === r) return c;
    return [c[0] * 0.3 + 0.25, c[1] * 0.3 + 0.25, c[2] * 0.3 + 0.25];
  });
}

export function scalarColors(values: ArrayLike<number>, min: number, max: number, map: (t: number) => RGB = viridis): Float32Array {
  const span = max - min || 1;
  return fill(values.length, (v) => map((values[v]! - min) / span));
}

/** CSS gradient string for a colormap legend. */
export function cssGradient(map: (t: number) => RGB, stops = 12): string {
  const parts: string[] = [];
  for (let i = 0; i <= stops; i++) {
    const [r, g, b] = map(i / stops);
    parts.push(`rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}) ${((100 * i) / stops).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
