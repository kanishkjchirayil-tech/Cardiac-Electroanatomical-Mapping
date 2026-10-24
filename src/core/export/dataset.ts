import type { SurfaceMesh } from '../mesh/types';
import type { MapPoint } from '../mapping/types';
import { REGIONS } from '../mesh/regions';
import { writePly } from '../mesh/io/ply';
import { writeVtk } from '../mesh/io/vtk';
import { DEPTH_CLASSES, LESION_STATUS, type GroundTruthLabels } from './labels';

/**
 * Dataset export (MODEL.md §7.2): acquired points with their recorded electrogram windows and,
 * optionally, ground-truth labels; meshes with per-vertex map values.
 */
export interface EgmExportOptions {
  /** Window before / after the reference activation, ms (each ≤ the recorded 350 ms). */
  preMs: number;
  postMs: number;
  /** Output sample rate: 2000 (as recorded) or 1000 Hz (2-sample boxcar, then decimation). */
  fs: 1000 | 2000;
}

export const DEFAULT_EGM_EXPORT: EgmExportOptions = { preMs: 200, postMs: 300, fs: 1000 };

export interface PointRecord {
  id: number;
  time_ms: number;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  vertex: number;
  projection_mm: number;
  region: string;
  catheter: string;
  electrode: string;
  lat_ms: number;
  lat_method: string;
  bipolar_mV: number;
  unipolar_mV: number;
  deflections: number;
  fractionated: boolean;
  double_potential: boolean;
  force_g: number;
  stable: boolean;
  position_sd_mm: number;
  cl_ms: number;
  excluded: boolean;
  tags: string;
  gt?: {
    fibrosis_density: number;
    fibrotic: boolean;
    fibrosis_depth_class: string;
    lesion_status: string;
    autonomic_zone: string;
    gp_density: number;
    critical_distance_mm: number;
  };
  egm: { fs: number; pre_ms: number; uni: number[]; bip: number[]; ref: number[] };
}

/** Cut [−pre, +post] ms around the reference from a recorded window and resample. */
export function exportWindow(x: Float32Array, fsIn: number, recordedPreMs: number, o: EgmExportOptions): number[] {
  const pre = Math.min(o.preMs, recordedPreMs);
  const a = Math.round(((recordedPreMs - pre) * fsIn) / 1000);
  const b = Math.min(x.length, Math.round(((recordedPreMs + o.postMs) * fsIn) / 1000) + 1);
  const seg = Array.from(x.subarray(a, b));
  if (o.fs === fsIn) return seg.map(round4);
  const k = Math.round(fsIn / o.fs);
  const out: number[] = [];
  for (let i = 0; i + k <= seg.length; i += k) {
    let s = 0;
    for (let j = 0; j < k; j++) s += seg[i + j]!;
    out.push(round4(s / k));
  }
  return out;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function pointRecords(points: MapPoint[], mesh: SurfaceMesh, labels: GroundTruthLabels | null, o: EgmExportOptions = DEFAULT_EGM_EXPORT): PointRecord[] {
  const N = mesh.normals;
  return points.map((p) => {
    const v = p.vertex;
    const rec: PointRecord = {
      id: p.id,
      time_ms: p.time,
      x: p.location[0], y: p.location[1], z: p.location[2],
      nx: N[3 * v]!, ny: N[3 * v + 1]!, nz: N[3 * v + 2]!,
      vertex: v,
      projection_mm: p.projectionDistance,
      region: REGIONS[mesh.region[v]!]?.key ?? 'unlabeled',
      catheter: p.catheter,
      electrode: p.electrode,
      lat_ms: p.ann.lat,
      lat_method: p.ann.method,
      bipolar_mV: p.ann.bipolarVoltage,
      unipolar_mV: p.ann.unipolarVoltage,
      deflections: p.ann.deflections,
      fractionated: p.ann.fractionated,
      double_potential: p.ann.doublePotential,
      force_g: p.force,
      stable: p.stable,
      position_sd_mm: p.positionSd,
      cl_ms: p.cl,
      excluded: p.excluded,
      tags: p.tags.join('|'),
      egm: {
        fs: o.fs,
        pre_ms: Math.min(o.preMs, p.window.preMs),
        uni: exportWindow(p.window.uni, p.window.fs, p.window.preMs, o),
        bip: exportWindow(p.window.bip, p.window.fs, p.window.preMs, o),
        ref: exportWindow(p.window.ref, p.window.fs, p.window.preMs, o),
      },
    };
    if (labels) {
      const z = labels.autonomicZone[v]!;
      rec.gt = {
        fibrosis_density: labels.fibrosisDensity[v]!,
        fibrotic: labels.fibroticNode[v] === 1,
        fibrosis_depth_class: DEPTH_CLASSES[labels.fibrosisDepthClass[v]!]!,
        lesion_status: LESION_STATUS[labels.lesionStatus[v]!]!,
        autonomic_zone: z >= 0 ? labels.gpNames[z]! : 'none',
        gp_density: labels.gpDensity[v]!,
        critical_distance_mm: labels.criticalDistance[v]!,
      };
    }
    return rec;
  });
}

const SCALAR_COLUMNS: Array<keyof PointRecord> = ['id', 'time_ms', 'x', 'y', 'z', 'nx', 'ny', 'nz', 'vertex', 'projection_mm', 'region', 'catheter', 'electrode', 'lat_ms', 'lat_method', 'bipolar_mV', 'unipolar_mV', 'deflections', 'fractionated', 'double_potential', 'force_g', 'stable', 'position_sd_mm', 'cl_ms', 'excluded', 'tags'];
const GT_COLUMNS = ['fibrosis_density', 'fibrotic', 'fibrosis_depth_class', 'lesion_status', 'autonomic_zone', 'gp_density', 'critical_distance_mm'] as const;

const cell = (v: unknown): string => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per point. EGM windows go in three columns as space-separated samples (mV). */
export function toCsv(records: PointRecord[]): string {
  const gt = records.some((r) => r.gt);
  const header = [...SCALAR_COLUMNS, ...(gt ? GT_COLUMNS.map((c) => `gt_${c}`) : []), 'egm_fs', 'egm_pre_ms', 'egm_uni', 'egm_bip', 'egm_ref'];
  const rows = records.map((r) => [
    ...SCALAR_COLUMNS.map((c) => cell(r[c])),
    ...(gt ? GT_COLUMNS.map((c) => cell(r.gt?.[c])) : []),
    cell(r.egm.fs), cell(r.egm.pre_ms), r.egm.uni.join(' '), r.egm.bip.join(' '), r.egm.ref.join(' '),
  ].join(','));
  return [header.join(','), ...rows].join('\n') + '\n';
}

export interface PointsFile {
  format: 'ostium-points/1';
  generator: string;
  notice: string;
  units: { position: 'mm (LPS)'; time: 'ms'; voltage: 'mV'; force: 'g' };
  scenario: string | null;
  seed: number;
  criticalLabel: string | null;
  egm: EgmExportOptions;
  points: PointRecord[];
}

export function toPointsJson(records: PointRecord[], meta: { scenario: string | null; seed: number; criticalLabel: string | null; egm: EgmExportOptions }): PointsFile {
  return {
    format: 'ostium-points/1',
    generator: 'Ostium educational simulator',
    notice: 'Educational simulation, not for clinical use. Fields under "gt" are hidden simulation ground truth.',
    units: { position: 'mm (LPS)', time: 'ms', voltage: 'mV', force: 'g' },
    ...meta,
    points: records,
  };
}

/** Per-vertex fields for a mesh export: anatomy, interpolated maps, and optional ground truth. */
export function meshFields(mesh: SurfaceMesh, maps: Record<string, Float32Array | null>, labels: GroundTruthLabels | null): Record<string, Float32Array> {
  const f: Record<string, Float32Array> = {
    region: Float32Array.from(mesh.region),
    wall_thickness: mesh.wallThickness.slice(),
  };
  for (const [name, values] of Object.entries(maps)) if (values) f[`map_${name}`] = values;
  if (labels) {
    f.gt_fibrosis_density = labels.fibrosisDensity;
    f.gt_fibrosis_depth_class = Float32Array.from(labels.fibrosisDepthClass);
    f.gt_lesion_status = Float32Array.from(labels.lesionStatus);
    f.gt_autonomic_zone = Float32Array.from(labels.autonomicZone);
    f.gt_gp_density = labels.gpDensity;
    f.gt_critical_distance = labels.criticalDistance;
  }
  return f;
}

/** Unmapped values are NaN in PLY and −9999 in VTK (legacy ASCII readers do not parse NaN). */
export const VTK_MISSING = -9999;

export function exportMesh(mesh: SurfaceMesh, fields: Record<string, Float32Array>, format: 'ply' | 'vtk'): Uint8Array | string {
  if (format === 'ply') return writePly(mesh, fields, 'binary');
  const clean = Object.fromEntries(Object.entries(fields).map(([k, a]) => [k, Float32Array.from(a, (x) => (Number.isFinite(x) ? x : VTK_MISSING))]));
  return writeVtk(mesh, clean, 'Ostium educational simulator export (LPS, mm); missing = -9999');
}
