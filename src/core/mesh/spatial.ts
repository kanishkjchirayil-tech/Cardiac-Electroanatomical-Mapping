/**
 * Uniform-grid spatial index over points (vertex positions, triangle centres) for nearest-point
 * and radius queries. Cell size should be on the order of the query radius.
 */
export class SpatialGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly min: [number, number, number];

  constructor(readonly points: Float32Array, readonly cell: number) {
    const n = points.length / 3;
    const mn: [number, number, number] = [Infinity, Infinity, Infinity];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mn[k] = Math.min(mn[k]!, points[3 * i + k]!);
    this.min = mn;
    for (let i = 0; i < n; i++) {
      const key = this.key(this.ci(points[3 * i]!, 0), this.ci(points[3 * i + 1]!, 1), this.ci(points[3 * i + 2]!, 2));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
  }

  private ci(x: number, axis: number): number {
    return Math.floor((x - this.min[axis]!) / this.cell);
  }

  private key(i: number, j: number, k: number): number {
    return ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);
  }

  /** Indices of points within distance r of p. */
  within(p: ArrayLike<number>, r: number, out: number[] = []): number[] {
    out.length = 0;
    const r2 = r * r;
    const lo = [0, 1, 2].map((a) => this.ci(p[a]! - r, a)), hi = [0, 1, 2].map((a) => this.ci(p[a]! + r, a));
    for (let i = lo[0]!; i <= hi[0]!; i++)
      for (let j = lo[1]!; j <= hi[1]!; j++)
        for (let k = lo[2]!; k <= hi[2]!; k++) {
          const list = this.cells.get(this.key(i, j, k));
          if (!list) continue;
          for (const q of list) {
            const dx = this.points[3 * q]! - p[0]!, dy = this.points[3 * q + 1]! - p[1]!, dz = this.points[3 * q + 2]! - p[2]!;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(q);
          }
        }
    return out;
  }

  /** Nearest point to p (searching outward ring by ring); returns index and distance. */
  nearest(p: ArrayLike<number>): { index: number; distance: number } {
    let best = -1, bd = Infinity;
    const c = [0, 1, 2].map((a) => this.ci(p[a]!, a));
    for (let ring = 0; ring < 64; ring++) {
      for (let i = c[0]! - ring; i <= c[0]! + ring; i++)
        for (let j = c[1]! - ring; j <= c[1]! + ring; j++)
          for (let k = c[2]! - ring; k <= c[2]! + ring; k++) {
            if (Math.max(Math.abs(i - c[0]!), Math.abs(j - c[1]!), Math.abs(k - c[2]!)) !== ring) continue;
            const list = this.cells.get(this.key(i, j, k));
            if (!list) continue;
            for (const q of list) {
              const d = (this.points[3 * q]! - p[0]!) ** 2 + (this.points[3 * q + 1]! - p[1]!) ** 2 + (this.points[3 * q + 2]! - p[2]!) ** 2;
              if (d < bd) { bd = d; best = q; }
            }
          }
      // Once something is found, one more ring guarantees correctness (cells are cubes).
      if (best >= 0 && Math.sqrt(bd) <= ring * this.cell) break;
    }
    return { index: best, distance: Math.sqrt(bd) };
  }
}
