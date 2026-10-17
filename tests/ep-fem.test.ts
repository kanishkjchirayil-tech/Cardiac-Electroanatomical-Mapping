import { describe, expect, it } from 'vitest';
import { hexSheet } from '../src/core/mesh/primitives';
import { buildDiffusion, buildGeometry, stableDiffusionDt } from '../src/core/ep/fem';
import { defaultAtrium } from './helpers';

describe('P1 FEM operators', () => {
  const sheet = hexSheet(20, 10, 1);
  const g = buildGeometry(sheet.positions, sheet.indices);

  it('lumped masses sum to the surface area', () => {
    const area = g.mass.reduce((a, b) => a + b, 0);
    const xs = Array.from({ length: g.nV }, (_, i) => g.positions[3 * i]!), ys = Array.from({ length: g.nV }, (_, i) => g.positions[3 * i + 1]!);
    const bbox = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    expect(area).toBeGreaterThan(0.95 * bbox);
    expect(area).toBeLessThan(1.001 * bbox);
  });

  it('cotangent Laplacian annihilates constant and (at interior nodes) linear fields', () => {
    const op = buildDiffusion(g, new Float32Array(g.edgeA.length).fill(1));
    for (let i = 0; i < g.nV; i++) {
      const x = g.positions[3 * i]!, y = g.positions[3 * i + 1]!;
      const interior = x > 1.5 && x < 18.5 && y > 1.5 && y < 8.5;
      let lin = 0;
      for (let k = op.rowPtr[i]!; k < op.rowPtr[i + 1]!; k++) {
        const j = op.col[k]!;
        lin += op.w[k]! * (2 * g.positions[3 * j]! + 3 * g.positions[3 * j + 1]! - (2 * x + 3 * y));
      }
      if (interior) expect(Math.abs(lin)).toBeLessThan(1e-4);
    }
  });

  it('the remeshed atrium has no negative cotangent weights and a stable 0.1 ms step', () => {
    const { mesh } = defaultAtrium();
    const ga = buildGeometry(mesh.positions, mesh.indices);
    expect(ga.negativeCotEdges).toBe(0);
    const op = buildDiffusion(ga, new Float32Array(ga.edgeA.length).fill(0.55));
    expect(stableDiffusionDt(op)).toBeGreaterThan(0.1);
  });
});
