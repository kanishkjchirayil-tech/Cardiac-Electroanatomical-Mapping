import { describe, expect, it } from 'vitest';
import { gridMesh } from './helpers';
import { edgeDijkstra } from '../src/core/mesh/geodesic';
import { vertexAdjacency, boundaryLoops, edgeStats } from '../src/core/mesh/topology';
import { meshQuality } from '../src/core/mesh/quality';

describe('mesh topology and geodesics', () => {
  const g = gridMesh(40, 1);
  const adj = vertexAdjacency(g.indices, g.positions.length / 3);

  it('grid is a disc: one boundary loop, χ = 1', () => {
    expect(boundaryLoops(g.indices).length).toBe(1);
    expect(meshQuality(g.positions, g.indices).eulerCharacteristic).toBe(1);
    expect(edgeStats(g.indices).duplicateHalfEdges).toBe(0);
  });

  it('edge Dijkstra approximates Euclidean distance on a flat sheet within 9%', () => {
    const src = 20 * 41 + 20; // centre
    const { distance } = edgeDijkstra(g.positions, adj, [src]);
    for (let v = 0; v < distance.length; v++) {
      const dx = g.positions[3 * v]! - 20, dy = g.positions[3 * v + 1]! - 20;
      const e = Math.hypot(dx, dy);
      if (e < 5) continue;
      expect(distance[v]!).toBeGreaterThanOrEqual(e - 1e-6);
      expect(distance[v]! / e).toBeLessThan(1.09);
    }
  });

  it('respects maxDistance and reports nearest source', () => {
    const r = edgeDijkstra(g.positions, adj, [0, 40 * 41 + 40], 10);
    expect(r.nearestSource[0]).toBe(0);
    expect(r.nearestSource[40 * 41 + 40]).toBe(1);
    expect(r.distance[20 * 41 + 20]).toBe(Infinity);
  });
});
