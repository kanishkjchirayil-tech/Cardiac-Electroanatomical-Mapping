import { triangleConductionVelocity } from '../core/math/gradient';
import { latColor, NO_DATA, srgbToLinear, voltageMapColor, type RGB } from '../render/colormaps';
import type { SurfaceMesh } from '../core/mesh/types';
import type { MapPoint } from '../core/mapping/types';
import * as M from './mapping-state';

/**
 * Map products derived from acquired points (MODEL.md §4.4–4.5): interpolated per-vertex values,
 * colours, colour range and conduction-velocity vectors.
 */
export interface MapProduct {
  type: M.MapType;
  /** Interpolated value per vertex (NaN = unmapped). */
  values: Float32Array;
  /** Colour range (LAT ms, voltage thresholds, deflection counts). */
  range: [number, number];
  /** Colour of each acquired point (sRGB), by id. */
  pointColor: Map<number, RGB>;
}

export function pointValue(p: MapPoint, type: M.MapType): number {
  switch (type) {
    case 'lat':
    case 'propagation': return p.ann.lat;
    case 'bipolar': return p.ann.bipolarVoltage;
    case 'unipolar': return p.ann.unipolarVoltage;
    case 'fractionation': return p.ann.deflections;
  }
}

export function computeMap(type: M.MapType): MapProduct | null {
  const s = M.session, interp = M.interpolator;
  if (!s || !interp) return null;
  const pts = s.mapPoints();
  const disp = M.mapDisplay.peek();
  const values = interp.interpolate(pts.map((p) => ({ id: p.id, vertex: p.vertex, location: p.location, value: pointValue(p, type) })), { fillThreshold: s.settings.fillThreshold });
  let range: [number, number];
  if (type === 'lat' || type === 'propagation') {
    if (disp.latRange) range = disp.latRange;
    else {
      // Robust automatic range: 2nd–98th percentile of point LATs.
      const v = pts.map((p) => p.ann.lat).filter(Number.isFinite).sort((a, b) => a - b);
      const q = (f: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))]!;
      range = v.length ? [q(0.02), q(0.98) > q(0.02) ? q(0.98) : q(0.02) + 1] : [0, 100];
    }
  } else if (type === 'bipolar') range = disp.bipolarThresholds;
  else if (type === 'unipolar') range = disp.unipolarThresholds;
  else range = [2, 8];
  const pointColor = new Map<number, RGB>();
  for (const p of s.points) pointColor.set(p.id, colorOf(type, pointValue(p, type), range));
  return { type, values, range, pointColor };
}

export function colorOf(type: M.MapType, v: number, range: [number, number]): RGB {
  if (!Number.isFinite(v)) return NO_DATA;
  switch (type) {
    case 'lat':
    case 'propagation': return latColor((v - range[0]) / Math.max(1e-6, range[1] - range[0]));
    case 'bipolar':
    case 'unipolar': return voltageMapColor(v, range[0], range[1]);
    case 'fractionation': return latColor(1 - (v - range[0]) / Math.max(1e-6, range[1] - range[0]));
  }
}

/** Per-vertex linear-RGB colours for the shell; `phase` (ms) animates the propagation map. */
export function mapColors(prod: MapProduct, out: Float32Array, phase?: number): Float32Array {
  const n = prod.values.length;
  for (let i = 0; i < n; i++) {
    const v = prod.values[i]!;
    let c = colorOf(prod.type, v, prod.range);
    if (prod.type === 'propagation' && Number.isFinite(v) && phase !== undefined) {
      // Dimmed static map with a bright band where the wavefront is (0–15 ms behind the phase).
      const age = phase - v;
      const k = age >= 0 && age < 15 ? 1 - age / 15 : 0;
      c = [0.35 * c[0] + 0.65 * k, 0.35 * c[1] + 0.65 * k, 0.35 * c[2] + 0.6 * k];
    }
    out[3 * i] = srgbToLinear(c[0]);
    out[3 * i + 1] = srgbToLinear(c[1]);
    out[3 * i + 2] = srgbToLinear(c[2]);
  }
  return out;
}

/**
 * Conduction-velocity arrows from the interpolated LAT map: per-triangle gradient direction,
 * thinned to about one arrow per 5 mm cell, keeping only plausible speeds (0.05–2.5 m/s; faster
 * apparent speeds occur at breakthroughs and collisions). Returns flat segment endpoints.
 */
export function cvArrows(mesh: SurfaceMesh, lat: Float32Array, cell = 5, length = 4): Float32Array {
  const cv = triangleConductionVelocity(mesh.positions, mesh.indices, lat);
  const P = mesh.positions, I = mesh.indices;
  const taken = new Set<string>();
  const seg: number[] = [];
  for (let f = 0; f < I.length / 3; f++) {
    const sp = cv.speed[f]!;
    if (!(sp >= 0.05 && sp <= 2.5)) continue;
    const c = [0, 1, 2].map((k) => (P[3 * I[3 * f]! + k]! + P[3 * I[3 * f + 1]! + k]! + P[3 * I[3 * f + 2]! + k]!) / 3);
    const key = c.map((x) => Math.floor(x / cell)).join(',');
    if (taken.has(key)) continue;
    taken.add(key);
    const d = [cv.dir[3 * f]!, cv.dir[3 * f + 1]!, cv.dir[3 * f + 2]!];
    const a = c.map((x, k) => x - (d[k]! * length) / 2), b = c.map((x, k) => x + (d[k]! * length) / 2);
    seg.push(...a, ...b);
    // Arrowhead: two short barbs in the plane of the triangle.
    const n = [mesh.normals[3 * I[3 * f]!]!, mesh.normals[3 * I[3 * f]! + 1]!, mesh.normals[3 * I[3 * f]! + 2]!];
    const side = [d[1]! * n[2]! - d[2]! * n[1]!, d[2]! * n[0]! - d[0]! * n[2]!, d[0]! * n[1]! - d[1]! * n[0]!];
    for (const sgn of [1, -1]) seg.push(...b, ...b.map((x, k) => x - d[k]! * 1.3 + sgn * side[k]! * 0.8));
  }
  return Float32Array.from(seg);
}

export { NO_DATA };
