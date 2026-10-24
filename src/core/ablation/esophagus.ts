import type { SurfaceMesh } from '../mesh/types';
import { Region } from '../mesh/regions';
import { Rng } from '../rng';
import type { Vec3 } from '../math/vec3';

/**
 * Esophageal zone (MODEL.md §5.3): the esophagus runs vertically behind the posterior LA,
 * usually slightly left of the midline. It is modelled as a vertical tube of radius 6 mm,
 * 2 mm posterior to the epicardium, at a seeded lateral position (x = 0.12·r_x ± 0.08·r_x).
 * Endocardial vertices on the posterior wall / inferior wall / antra within 9 mm (in x) of the
 * tube's centreline form the warning zone.
 */
export interface EsophagusModel {
  /** Tube centreline (polyline, LPS mm) for display. */
  path: Vec3[];
  radius: number;
  zone: Uint8Array;
}

export function buildEsophagus(mesh: SurfaceMesh, seed = 1): EsophagusModel {
  // The esophagus lies behind the LA; the RA chamber has no esophageal zone.
  if (mesh.chamber === 'RA') return { path: [], radius: 0, zone: new Uint8Array(mesh.region.length) };
  const rx = mesh.anatomy?.bodyRadii[0] ?? 35;
  const rng = new Rng(seed ^ 0x350);
  const xc = (0.12 + rng.uniform(-0.08, 0.08)) * rx;
  const n = mesh.region.length;
  const zone = new Uint8Array(n);
  const allowed = new Set<number>([Region.Posterior, Region.Inferior, Region.LIPVAntrum, Region.RIPVAntrum, Region.LSPVAntrum, Region.RSPVAntrum, Region.Roof]);
  let yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[3 * i]!, y = mesh.positions[3 * i + 1]!, z = mesh.positions[3 * i + 2]!;
    if (Math.abs(x - xc) < 9 && allowed.has(mesh.region[i]!) && mesh.normals[3 * i + 1]! > 0.5) {
      zone[i] = 1;
      yMax = Math.max(yMax, y + mesh.wallThickness[i]!);
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
    }
  }
  const radius = 6;
  const yc = (Number.isFinite(yMax) ? yMax : 30) + 2 + radius;
  const path: Vec3[] = [];
  for (let z = (Number.isFinite(zMin) ? zMin : -30) - 25; z <= (Number.isFinite(zMax) ? zMax : 30) + 25; z += 5) path.push([xc, yc, z]);
  return { path, radius, zone };
}
