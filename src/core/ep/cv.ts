/**
 * Local conduction velocity from activation times on a triangulated surface: per triangle,
 * the gradient of the linear interpolant of T gives the slowness vector, CV = 1/|∇T| (mm/ms = m/s).
 */
export interface TriangleCv {
  /** Speed per triangle (m/s); NaN where any corner is unactivated or |∇T| ≈ 0. */
  speed: Float32Array;
  /** Unit propagation direction per triangle (3 × nF). */
  dir: Float32Array;
}

export function triangleConductionVelocity(positions: Float32Array, indices: Uint32Array, T: ArrayLike<number>): TriangleCv {
  const nF = indices.length / 3;
  const speed = new Float32Array(nF).fill(NaN);
  const dir = new Float32Array(3 * nF);
  const P = positions;
  for (let f = 0; f < nF; f++) {
    const a = indices[3 * f]!, b = indices[3 * f + 1]!, c = indices[3 * f + 2]!;
    const ta = T[a]!, tb = T[b]!, tc = T[c]!;
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || !Number.isFinite(tc)) continue;
    const e1 = [P[3 * b]! - P[3 * a]!, P[3 * b + 1]! - P[3 * a + 1]!, P[3 * b + 2]! - P[3 * a + 2]!];
    const e2 = [P[3 * c]! - P[3 * a]!, P[3 * c + 1]! - P[3 * a + 1]!, P[3 * c + 2]! - P[3 * a + 2]!];
    const g11 = e1[0]! ** 2 + e1[1]! ** 2 + e1[2]! ** 2;
    const g22 = e2[0]! ** 2 + e2[1]! ** 2 + e2[2]! ** 2;
    const g12 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!;
    const det = g11 * g22 - g12 * g12;
    if (det <= 1e-12) continue;
    // ∇T = α e1 + β e2 with [g11 g12; g12 g22][α; β] = [tb − ta; tc − ta].
    const d1 = tb - ta, d2 = tc - ta;
    const al = (g22 * d1 - g12 * d2) / det, be = (g11 * d2 - g12 * d1) / det;
    const gx = al * e1[0]! + be * e2[0]!, gy = al * e1[1]! + be * e2[1]!, gz = al * e1[2]! + be * e2[2]!;
    const gn = Math.hypot(gx, gy, gz);
    if (gn < 1e-6) continue;
    speed[f] = 1 / gn;
    dir[3 * f] = gx / gn;
    dir[3 * f + 1] = gy / gn;
    dir[3 * f + 2] = gz / gn;
  }
  return { speed, dir };
}

export function median(values: ArrayLike<number>): number {
  const v = Array.from(values).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : 0.5 * (v[m - 1]! + v[m]!);
}
