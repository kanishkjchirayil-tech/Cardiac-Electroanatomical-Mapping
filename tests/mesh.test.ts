import { describe, expect, it } from 'vitest';
import { defaultAtrium } from './helpers';
import { generateAtrium } from '../src/core/mesh/atrium';
import { REGIONS, Region, PV_REGIONS } from '../src/core/mesh/regions';
import { boundaryLoops } from '../src/core/mesh/topology';
import type { Vec3 } from '../src/core/math/vec3';

const regionCentroid = (pos: Float32Array, region: Uint8Array, r: Region): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  let n = 0;
  region.forEach((x, v) => {
    if (x !== r) return;
    c[0] += pos[3 * v]!; c[1] += pos[3 * v + 1]!; c[2] += pos[3 * v + 2]!;
    n++;
  });
  return [c[0] / n, c[1] / n, c[2] / n];
};

describe('procedural left atrium', () => {
  const { mesh, quality: q, shape } = defaultAtrium();

  it('is a consistently oriented 2-manifold with exactly 5 openings (4 PV + MV)', () => {
    expect(q.nonManifoldEdges).toBe(0);
    expect(q.duplicateHalfEdges).toBe(0);
    expect(q.boundaryLoopCount).toBe(5);
    // Sphere with 5 holes: χ = 2 − 5.
    expect(q.eulerCharacteristic).toBe(-3);
    expect(mesh.boundaryLoops.map((l) => l.label)).toEqual(['LSPV', 'LIPV', 'RSPV', 'RIPV', 'MV']);
    expect(boundaryLoops(mesh.indices).length).toBe(5);
  });

  it('has ~1 mm isotropic resolution in the 15–30k vertex range', () => {
    expect(q.meanEdge).toBeGreaterThan(0.85);
    expect(q.meanEdge).toBeLessThan(1.15);
    expect(q.vertices).toBeGreaterThanOrEqual(15_000);
    expect(q.vertices).toBeLessThanOrEqual(30_000);
    expect(q.minAngleDeg).toBeGreaterThan(20);
    expect(q.obtuseFraction).toBeLessThan(0.02);
    // Endocardial area of a moderately dilated LA (cm²).
    expect(q.area / 100).toBeGreaterThan(100);
    expect(q.area / 100).toBeLessThan(200);
  });

  it('has outward-facing triangles everywhere (no fold-overs)', () => {
    const P = mesh.positions, I = mesh.indices;
    let folds = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t]!, b = 3 * I[t + 1]!, c = 3 * I[t + 2]!;
      const u = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
      const w = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const g = shape.normal([(P[a]! + P[b]! + P[c]!) / 3, (P[a + 1]! + P[b + 1]! + P[c + 1]!) / 3, (P[a + 2]! + P[b + 2]! + P[c + 2]!) / 3]);
      if (n[0]! * g[0] + n[1]! * g[1] + n[2]! * g[2] <= 0) folds++;
    }
    expect(folds).toBe(0);
  });

  it('labels every vertex and contains every anatomical segment', () => {
    expect(mesh.region.every((r) => r !== Region.Unlabeled)).toBe(true);
    const present = new Set(mesh.region);
    // Left-atrial segments only (ids below RAFreeWall belong to the LA).
    for (const r of REGIONS) if (r.id !== Region.Unlabeled && r.id < Region.RAFreeWall) expect(present.has(r.id), r.name).toBe(true);
    expect([...present].every((r) => r < Region.RAFreeWall)).toBe(true);
  });

  it('places segments in anatomically plausible positions (LPS frame)', () => {
    const c = (r: Region) => regionCentroid(mesh.positions, mesh.region, r);
    const [lspv, lipv, rspv, ripv] = PV_REGIONS.map(c) as [Vec3, Vec3, Vec3, Vec3];
    expect(lspv[0]).toBeGreaterThan(0); expect(lspv[1]).toBeGreaterThan(0); expect(lspv[2]).toBeGreaterThan(0);
    expect(lipv[0]).toBeGreaterThan(0); expect(lipv[1]).toBeGreaterThan(0); expect(lipv[2]).toBeLessThan(0);
    expect(rspv[0]).toBeLessThan(0); expect(rspv[1]).toBeGreaterThan(0); expect(rspv[2]).toBeGreaterThan(0);
    expect(ripv[0]).toBeLessThan(0); expect(ripv[1]).toBeGreaterThan(0); expect(ripv[2]).toBeLessThan(0);
    expect(c(Region.Septum)[0]).toBeLessThan(0);
    expect(c(Region.Roof)[2]).toBeGreaterThan(0);
    expect(c(Region.Posterior)[1]).toBeGreaterThan(0);
    const laa = c(Region.LAA);
    expect(laa[0]).toBeGreaterThan(0);
    expect(laa[1]).toBeLessThan(0);
    const mv = c(Region.MitralAnnulus);
    expect(mv[1]).toBeLessThan(0);
    expect(mv[2]).toBeLessThan(0);
    // Mitral isthmus lies between the LIPV and the lateral annulus.
    const mi = c(Region.MitralIsthmus);
    expect(mi[0]).toBeGreaterThan(0);
  });

  it('has PV loops on vein sleeves and the MV loop on the annulus', () => {
    for (const loop of mesh.boundaryLoops) {
      const regions = new Set(Array.from(loop.vertices, (v) => mesh.region[v]!));
      if (loop.label === 'MV') {
        for (const r of regions) expect([Region.MitralAnnulus, Region.MitralIsthmus]).toContain(r);
      } else {
        const expected = PV_REGIONS[['LSPV', 'LIPV', 'RSPV', 'RIPV'].indexOf(loop.label)]!;
        expect([...regions]).toEqual([expected]);
      }
    }
    for (const pv of mesh.anatomy!.pvs) expect(pv.ostiumRing.length).toBeGreaterThan(20);
    expect(mesh.anatomy!.mitral.radius).toBeGreaterThan(12);
    expect(mesh.anatomy!.mitral.radius).toBeLessThan(22);
  });

  it('assigns wall thickness in the 0.5–4 mm range with regional differences', () => {
    let sum = 0;
    for (const t of mesh.wallThickness) {
      expect(t).toBeGreaterThanOrEqual(0.5);
      expect(t).toBeLessThanOrEqual(4);
      sum += t;
    }
    const mean = sum / mesh.wallThickness.length;
    expect(mean).toBeGreaterThan(1);
    expect(mean).toBeLessThan(3);
    const meanOf = (r: Region) => {
      let s = 0, n = 0;
      mesh.region.forEach((x, v) => { if (x === r) { s += mesh.wallThickness[v]!; n++; } });
      return s / n;
    };
    expect(meanOf(Region.LSPV)).toBeLessThan(meanOf(Region.Posterior));
    expect(meanOf(Region.Posterior)).toBeLessThan(meanOf(Region.MitralIsthmus));
  });

  it('is deterministic for a given seed and varies with seed when variability > 0', () => {
    const a = generateAtrium({ targetEdge: 2.5, gridSpacing: 2, remeshIterations: 3, seed: 7, variability: 1 });
    const b = generateAtrium({ targetEdge: 2.5, gridSpacing: 2, remeshIterations: 3, seed: 7, variability: 1 });
    const c = generateAtrium({ targetEdge: 2.5, gridSpacing: 2, remeshIterations: 3, seed: 8, variability: 1 });
    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.region)).toEqual(Array.from(b.mesh.region));
    expect(a.mesh.positions.length === c.mesh.positions.length && a.mesh.positions.every((x, i) => x === c.mesh.positions[i])).toBe(false);
    expect(c.quality.boundaryLoopCount).toBe(5);
    expect(c.quality.nonManifoldEdges).toBe(0);
  });

  it('stays a valid 5-opening manifold under strong anatomical variability', () => {
    for (const seed of [5, 6, 7]) {
      const r = generateAtrium({ seed, variability: 2, targetEdge: 1.5, gridSpacing: 1.2, remeshIterations: 4 });
      expect(r.quality.boundaryLoopCount, `seed ${seed}`).toBe(5);
      expect(r.quality.eulerCharacteristic, `seed ${seed}`).toBe(-3);
      expect(r.quality.nonManifoldEdges).toBe(0);
      expect(r.mesh.boundaryLoops.map((l) => l.label)).toEqual(['LSPV', 'LIPV', 'RSPV', 'RIPV', 'MV']);
    }
  });
});
