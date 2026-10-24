import type { SurfaceMesh } from '../mesh/types';
import type { Substrate } from '../ep/substrate';
import { vertexAdjacency } from '../mesh/topology';
import { edgeDijkstra } from '../mesh/geodesic';
import { gpDensity, gpEfficacy, gpZoneIndex, type GpZone } from '../ep/autonomic';

/**
 * Per-vertex ground-truth labels for dataset export (MODEL.md §7.2). These come from the hidden
 * tissue state; they are attached to exported points as labels and are never used to build maps.
 */
export interface GroundTruthLabels {
  scenario: string | null;
  seed: number;
  fibrosisDensity: Float32Array;
  fibroticNode: Uint8Array;
  /** 0 none, 1 endocardial, 2 mid-wall, 3 transmural (DEPTH_CLASSES). */
  fibrosisDepthClass: Uint8Array;
  /** 0 none, 1 partial / border, 2 core (LESION_STATUS); edema counts while active. */
  lesionStatus: Uint8Array;
  /** Index into gpNames, or −1 outside every GP zone. */
  autonomicZone: Int8Array;
  gpNames: string[];
  /** GP innervation density after ablation, 0..1. */
  gpDensity: Float32Array;
  /** Geodesic (edge-path) distance to the scenario's critical site, mm; NaN when there is none. */
  criticalDistance: Float32Array;
  criticalLabel: string;
}

export const DEPTH_CLASSES = ['none', 'endocardial', 'mid-wall', 'transmural'] as const;
export const LESION_STATUS = ['none', 'partial', 'core'] as const;

/** Fibrosis depth class from density (0 = none) and transmural extent (fraction of wall). */
export function fibrosisDepthClass(density: number, depth: number): number {
  if (!(density > 0)) return 0;
  return depth < 1 / 3 ? 1 : depth < 2 / 3 ? 2 : 3;
}

export function buildLabels(
  mesh: SurfaceMesh,
  sub: Substrate,
  lesionKind: Uint8Array | null,
  zones: GpZone[],
  critical: { vertices: number[]; label: string } | null,
  meta: { scenario: string | null; seed: number },
): GroundTruthLabels {
  const n = mesh.region.length;
  const depthClass = new Uint8Array(n);
  for (let i = 0; i < n; i++) depthClass[i] = fibrosisDepthClass(sub.fibrosisDensity[i]!, sub.fibrosisDepth[i]!);
  let criticalDistance = new Float32Array(n).fill(NaN);
  if (critical && critical.vertices.length) {
    const d = edgeDijkstra(mesh.positions, vertexAdjacency(mesh.indices, n), critical.vertices).distance;
    criticalDistance = Float32Array.from(d, (x) => (Number.isFinite(x) ? x : NaN));
  }
  return {
    scenario: meta.scenario,
    seed: meta.seed,
    fibrosisDensity: sub.fibrosisDensity.slice(),
    fibroticNode: sub.fibroticNode.slice(),
    fibrosisDepthClass: depthClass,
    lesionStatus: lesionKind ? lesionKind.slice() : new Uint8Array(n),
    autonomicZone: gpZoneIndex(zones, n),
    gpNames: zones.map((z) => z.name),
    gpDensity: gpDensity(zones, n, gpEfficacy(zones, lesionKind)),
    criticalDistance,
    criticalLabel: critical?.label ?? 'none',
  };
}
