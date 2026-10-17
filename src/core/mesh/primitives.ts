/**
 * Simple test/calibration meshes built from an equilateral triangular lattice, which matches the
 * local structure (valence 6, ~60° angles) of the isotropically remeshed atrium.
 */
export interface SimpleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Flat sheet in the xy plane, x ∈ [0, width], y ∈ [0, height], edge length h. */
export function hexSheet(width: number, height: number, h: number): SimpleMesh & { cols: number; rows: number } {
  const dy = (h * Math.sqrt(3)) / 2;
  const rows = Math.round(height / dy) + 1;
  const cols = Math.round(width / h) + 1;
  const pos: number[] = [];
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? h / 2 : 0;
    for (let c = 0; c < cols; c++) pos.push(Math.min(width, c * h + off), r * dy, 0);
  }
  const id = (r: number, c: number) => r * cols + c;
  const idx: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      if (r % 2 === 0) idx.push(id(r, c), id(r, c + 1), id(r + 1, c), id(r, c + 1), id(r + 1, c + 1), id(r + 1, c));
      else idx.push(id(r, c), id(r, c + 1), id(r + 1, c + 1), id(r, c), id(r + 1, c + 1), id(r + 1, c));
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), cols, rows };
}

/**
 * Open cylinder of radius R and height H around the z axis (a "ring" of tissue without the
 * metric distortion of a flat annulus). Vertex angle θ = 2π·col/cols.
 */
export function cylinderRing(R: number, H: number, h: number): SimpleMesh & { cols: number; rows: number } {
  const cols = Math.round((2 * Math.PI * R) / h);
  const dy = (h * Math.sqrt(3)) / 2;
  const rows = Math.round(H / dy) + 1;
  const pos: number[] = [];
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? 0.5 : 0;
    for (let c = 0; c < cols; c++) {
      const th = (2 * Math.PI * (c + off)) / cols;
      pos.push(R * Math.cos(th), R * Math.sin(th), r * dy);
    }
  }
  const id = (r: number, c: number) => r * cols + (((c % cols) + cols) % cols);
  const idx: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r % 2 === 0) idx.push(id(r, c), id(r, c + 1), id(r + 1, c), id(r, c + 1), id(r + 1, c + 1), id(r + 1, c));
      else idx.push(id(r, c), id(r, c + 1), id(r + 1, c + 1), id(r, c), id(r + 1, c + 1), id(r + 1, c));
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), cols, rows };
}
