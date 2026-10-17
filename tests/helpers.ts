import { generateAtrium, type AtriumGenResult } from '../src/core/mesh/atrium';

let cached: AtriumGenResult | null = null;

/** Default procedural atrium, generated once per test file. */
export function defaultAtrium(): AtriumGenResult {
  cached ??= generateAtrium();
  return cached;
}

/** Fast, coarse atrium for I/O tests. */
export function coarseAtrium(): AtriumGenResult {
  return generateAtrium({ targetEdge: 2.5, gridSpacing: 2, remeshIterations: 3 });
}

/** Flat triangulated grid in the xy plane, spacing h, (n+1)×(n+1) vertices. */
export function gridMesh(n: number, h: number): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i * h, j * h, 0);
  const id = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      // Alternate diagonals to avoid a directional bias.
      if ((i + j) % 2 === 0) idx.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
      else idx.push(id(i, j), id(i + 1, j), id(i, j + 1), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
