import { describe, expect, it } from 'vitest';
import { coarseAtrium } from './helpers';
import { parseObj, writeObj } from '../src/core/mesh/io/obj';
import { parsePly, writePly } from '../src/core/mesh/io/ply';
import { parseVtk, writeVtk } from '../src/core/mesh/io/vtk';
import { importMesh, makeSidecar } from '../src/core/mesh/io/import';
import { Region } from '../src/core/mesh/regions';

const { mesh } = coarseAtrium();
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(tol);
};

describe('mesh file I/O', () => {
  it('round-trips OBJ', () => {
    const raw = parseObj(writeObj(mesh));
    close(raw.positions, mesh.positions, 1e-5);
    expect(Array.from(raw.indices)).toEqual(Array.from(mesh.indices));
  });

  it('round-trips binary and ASCII PLY with per-vertex data', () => {
    for (const fmt of ['binary', 'ascii'] as const) {
      const raw = parsePly(writePly(mesh, { region: mesh.region, thickness: mesh.wallThickness }, fmt));
      close(raw.positions, mesh.positions, 1e-5);
      expect(Array.from(raw.indices)).toEqual(Array.from(mesh.indices));
      close(raw.pointData.region!, mesh.region, 1e-6);
      close(raw.pointData.thickness!, mesh.wallThickness, 1e-5);
    }
  });

  it('round-trips legacy ASCII VTK with point data', () => {
    const raw = parseVtk(writeVtk(mesh, { region: mesh.region }));
    close(raw.positions, mesh.positions, 1e-5);
    expect(Array.from(raw.indices)).toEqual(Array.from(mesh.indices));
    close(raw.pointData.region!, mesh.region, 1e-6);
  });

  it('imports with a sidecar: labels, thickness and loop names survive', () => {
    const sidecar = JSON.parse(JSON.stringify(makeSidecar(mesh)));
    const { mesh: m, warnings } = importMesh(parseObj(writeObj(mesh)), sidecar);
    expect(warnings.filter((w) => !w.startsWith('Mean edge'))).toEqual([]);
    expect(Array.from(m.region)).toEqual(Array.from(mesh.region));
    close(m.wallThickness, mesh.wallThickness, 1e-3);
    expect(m.boundaryLoops.map((l) => l.label).sort()).toEqual(['LIPV', 'LSPV', 'MV', 'RIPV', 'RSPV']);
  });

  it('imports without a sidecar using PLY point data, and applies units', () => {
    const ply = writePly(mesh, { region: mesh.region });
    const { mesh: m, warnings } = importMesh(parsePly(ply), { units: 'cm' });
    expect(m.positions[0]).toBeCloseTo(mesh.positions[0]! * 10, 3);
    expect(Array.from(m.region)).toEqual(Array.from(mesh.region));
    expect(warnings.some((w) => w.includes('wall thickness'))).toBe(true);
  });

  it('parses OBJ quads, negative indices and welds duplicate vertices', () => {
    const obj = ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 4', 'v 1 0 0', 'v 2 0 0', 'v 2 1 0', 'f -3 -2 -1'].join('\n');
    const raw = parseObj(obj);
    expect(raw.indices.length).toBe(9);
    const { mesh: m, warnings } = importMesh(raw, { region: Array(7).fill('roof') });
    expect(m.positions.length / 3).toBe(6);
    expect(m.region.every((r) => r === Region.Roof)).toBe(true);
    expect(warnings.some((w) => w.startsWith('Welded'))).toBe(true);
  });

  it('parses VTK unstructured grids with triangle cells', () => {
    const vtk = `# vtk DataFile Version 3.0\nt\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 4 float\n0 0 0 1 0 0 0 1 0 0 0 1\nCELLS 2 8\n3 0 1 2\n3 0 1 3\nCELL_TYPES 2\n5\n5\n`;
    const raw = parseVtk(vtk);
    expect(Array.from(raw.indices)).toEqual([0, 1, 2, 0, 1, 3]);
  });

  it('rejects sidecars whose length does not match', () => {
    expect(() => importMesh(parseObj(writeObj(mesh)), { region: [1, 2, 3] })).toThrow();
  });
});
