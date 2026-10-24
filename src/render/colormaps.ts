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

function ramp(stops: RGB[], t: number): RGB {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i]!, b = stops[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Conventional activation-map scale: red (earliest) → orange → yellow → green → blue → purple (latest). */
export const LAT_STOPS: RGB[] = [
  [0.86, 0.08, 0.08],
  [0.98, 0.5, 0.05],
  [0.98, 0.9, 0.1],
  [0.15, 0.75, 0.25],
  [0.1, 0.4, 0.95],
  [0.55, 0.15, 0.8],
];
export const latColor = (t: number): RGB => ramp(LAT_STOPS, t);

/** Transmembrane voltage, normalized v ∈ [0, 1]: resting slate blue → depolarized amber → peak cream. */
export const VOLTAGE_STOPS: RGB[] = [
  [0.16, 0.24, 0.36],
  [0.42, 0.3, 0.42],
  [0.92, 0.45, 0.18],
  [1.0, 0.86, 0.45],
];
export const voltageColor = (v: number): RGB => ramp(VOLTAGE_STOPS, v);

export const UNMAPPED: RGB = [0.5, 0.5, 0.52];
export const FIBROTIC: RGB = [0.22, 0.22, 0.24];

/** Fill a preallocated linear-RGB buffer from per-vertex values without allocating. */
export function writeColors(out: Float32Array, n: number, f: (i: number) => RGB): void {
  for (let i = 0; i < n; i++) {
    const c = f(i);
    out[3 * i] = srgbToLinear(c[0]);
    out[3 * i + 1] = srgbToLinear(c[1]);
    out[3 * i + 2] = srgbToLinear(c[2]);
  }
}

/** Below the voltage scar threshold. */
export const SCAR: RGB = [0.3, 0.31, 0.33];
/** Beyond the fill threshold (no data). */
export const NO_DATA: RGB = [0.62, 0.62, 0.64];

/** Voltage map: scar grey below `scar`, red → purple between thresholds, purple above `normal`. */
export function voltageMapColor(v: number, scar: number, normal: number): RGB {
  if (!Number.isFinite(v)) return NO_DATA;
  if (v < scar) return SCAR;
  return latColor((v - scar) / Math.max(1e-6, normal - scar));
}

/** Lesion tags by quality index (10 ⇔ predicted transmural): green ≥ 10, amber 8–10, red < 8. */
export const LESION_GOOD: RGB = [0.2, 0.75, 0.35];
export const LESION_FAIR: RGB = [0.95, 0.68, 0.15];
export const LESION_POOR: RGB = [0.88, 0.2, 0.2];
export const lesionTagColor = (lqi: number, target = 10): RGB => (lqi >= target ? LESION_GOOD : lqi >= 0.8 * target ? LESION_FAIR : LESION_POOR);
/** Teacher view: transmural lesion core and border / partial-thickness lesion. */
export const LESION_CORE: RGB = [0.42, 0.1, 0.14];
export const LESION_BORDER: RGB = [0.86, 0.55, 0.6];
