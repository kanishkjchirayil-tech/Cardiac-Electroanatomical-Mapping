import type { Vec3 } from '../math/vec3';

/**
 * Naive surface nets: one vertex per sign-changing grid cell (mean of edge crossings),
 * one quad per sign-changing grid edge. Produces a closed, consistently oriented
 * (outward = towards f > 0) quad-dominant surface that is later remeshed.
 */
export function surfaceNets(
  f: (x: number, y: number, z: number) => number,
  min: Vec3,
  max: Vec3,
  spacing: number,
): { positions: number[]; indices: number[] } {
  const nx = Math.ceil((max[0] - min[0]) / spacing) + 1;
  const ny = Math.ceil((max[1] - min[1]) / spacing) + 1;
  const nz = Math.ceil((max[2] - min[2]) / spacing) + 1;
  const F = new Float32Array(nx * ny * nz);
  const gi = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let v = f(min[0] + i * spacing, min[1] + j * spacing, min[2] + k * spacing);
        // Never exactly zero: keeps the sign test unambiguous.
        if (v === 0) v = 1e-9;
        // Force the grid border outside so the surface is closed.
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) v = Math.max(v, 1e-3);
        F[gi(i, j, k)] = v;
      }

  const cx = nx - 1, cy = ny - 1;
  const ci = (i: number, j: number, k: number) => i + cx * (j + cy * k);
  const cellVert = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const positions: number[] = [];
  const corner = new Float32Array(8);
  // Cube edges as corner-index pairs; corner c = dx + 2*dy + 4*dz.
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ] as const;
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = F[gi(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]!;
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const fa = corner[a]!, fb = corner[b]!;
          if (fa < 0 === fb < 0) continue;
          const t = fa / (fa - fb);
          sx += (a & 1) + t * ((b & 1) - (a & 1));
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          n++;
        }
        cellVert[ci(i, j, k)] = positions.length / 3;
        positions.push(min[0] + (i + sx / n) * spacing, min[1] + (j + sy / n) * spacing, min[2] + (k + sz / n) * spacing);
      }

  const indices: number[] = [];
  const P = (v: number, c: number) => positions[3 * v + c]!;
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) [b, d] = [d, b];
    // Split along the shorter diagonal.
    const dac = (P(a, 0) - P(c, 0)) ** 2 + (P(a, 1) - P(c, 1)) ** 2 + (P(a, 2) - P(c, 2)) ** 2;
    const dbd = (P(b, 0) - P(d, 0)) ** 2 + (P(b, 1) - P(d, 1)) ** 2 + (P(b, 2) - P(d, 2)) ** 2;
    if (dac <= dbd) indices.push(a, b, c, a, c, d);
    else indices.push(a, b, d, b, c, d);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const f0 = F[gi(i, j, k)]!;
        const inside = f0 < 0;
        // x-edge: quad in the yz plane, CCW seen from +x.
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && inside !== F[gi(i + 1, j, k)]! < 0) {
          quad(cellVert[ci(i, j - 1, k - 1)]!, cellVert[ci(i, j, k - 1)]!, cellVert[ci(i, j, k)]!, cellVert[ci(i, j - 1, k)]!, !inside);
        }
        // y-edge: quad in the zx plane, CCW seen from +y.
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && inside !== F[gi(i, j + 1, k)]! < 0) {
          quad(cellVert[ci(i - 1, j, k - 1)]!, cellVert[ci(i - 1, j, k)]!, cellVert[ci(i, j, k)]!, cellVert[ci(i, j, k - 1)]!, !inside);
        }
        // z-edge: quad in the xy plane, CCW seen from +z.
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && inside !== F[gi(i, j, k + 1)]! < 0) {
          quad(cellVert[ci(i - 1, j - 1, k)]!, cellVert[ci(i, j - 1, k)]!, cellVert[ci(i, j, k)]!, cellVert[ci(i - 1, j, k)]!, !inside);
        }
      }
  return { positions, indices };
}
