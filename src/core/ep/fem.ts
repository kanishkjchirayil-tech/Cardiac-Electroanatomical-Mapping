/**
 * P1 finite-element operators on a triangulated surface (MODEL.md §2.1).
 *
 * Monodomain diffusion term ∇·(D∇V) is discretized with the cotangent stiffness matrix and a
 * lumped (barycentric) mass matrix:  M_i dV_i/dt = Σ_j w_ij D_ij (V_j − V_i),
 * w_ij = ½(cot α_ij + cot β_ij). Open boundaries need no special treatment: the natural (Neumann,
 * no-flux) condition is built into the FEM weak form.
 */
export interface TissueGeometry {
  nV: number;
  positions: Float32Array;
  /** Lumped vertex area (mm²): one third of the incident triangle areas. */
  mass: Float64Array;
  /** Undirected edges a<b. */
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  /** ½(cot α + cot β), clamped at 0 (see negativeCotEdges). */
  edgeCot: Float64Array;
  edgeLength: Float64Array;
  /** CSR over vertices: for row i, entries k in [rowPtr[i], rowPtr[i+1]) give neighbour col[k] via edge edgeOf[k]. */
  rowPtr: Uint32Array;
  col: Uint32Array;
  edgeOf: Uint32Array;
  /** Edges whose raw cotangent weight was negative before clamping (non-Delaunay pairs). */
  negativeCotEdges: number;
  meanEdge: number;
}

export function buildGeometry(positions: Float32Array, indices: Uint32Array): TissueGeometry {
  const nV = positions.length / 3;
  const mass = new Float64Array(nV);
  const edgeIndex = new Map<number, number>();
  const ea: number[] = [], eb: number[] = [], cot: number[] = [];
  const P = positions;
  const edge = (a: number, b: number): number => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * 0x200000 + hi;
    let e = edgeIndex.get(key);
    if (e === undefined) {
      e = ea.length;
      edgeIndex.set(key, e);
      ea.push(lo);
      eb.push(hi);
      cot.push(0);
    }
    return e;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const p = v.map((i) => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!]);
    const ux = p[1]![0]! - p[0]![0]!, uy = p[1]![1]! - p[0]![1]!, uz = p[1]![2]! - p[0]![2]!;
    const vx = p[2]![0]! - p[0]![0]!, vy = p[2]![1]! - p[0]![1]!, vz = p[2]![2]! - p[0]![2]!;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    for (const i of v) mass[i] = mass[i]! + area / 3;
    // For each corner k, the opposite edge gets ½ cot(angle at k).
    for (let k = 0; k < 3; k++) {
      const o = p[k]!, a = p[(k + 1) % 3]!, b = p[(k + 2) % 3]!;
      const ax = a[0]! - o[0]!, ay = a[1]! - o[1]!, az = a[2]! - o[2]!;
      const bx = b[0]! - o[0]!, by = b[1]! - o[1]!, bz = b[2]! - o[2]!;
      const dotp = ax * bx + ay * by + az * bz;
      const crossn = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      const e = edge(v[(k + 1) % 3]!, v[(k + 2) % 3]!);
      cot[e] = cot[e]! + (0.5 * dotp) / Math.max(crossn, 1e-12);
    }
  }
  const nE = ea.length;
  const edgeA = Uint32Array.from(ea), edgeB = Uint32Array.from(eb);
  const edgeCot = new Float64Array(nE);
  const edgeLength = new Float64Array(nE);
  let negative = 0, sumLen = 0;
  for (let e = 0; e < nE; e++) {
    if (cot[e]! < 0) negative++;
    edgeCot[e] = Math.max(0, cot[e]!);
    const a = 3 * edgeA[e]!, b = 3 * edgeB[e]!;
    edgeLength[e] = Math.hypot(P[a]! - P[b]!, P[a + 1]! - P[b + 1]!, P[a + 2]! - P[b + 2]!);
    sumLen += edgeLength[e]!;
  }
  // CSR rows.
  const deg = new Uint32Array(nV);
  for (let e = 0; e < nE; e++) { deg[edgeA[e]!]!++; deg[edgeB[e]!]!++; }
  const rowPtr = new Uint32Array(nV + 1);
  for (let i = 0; i < nV; i++) rowPtr[i + 1] = rowPtr[i]! + deg[i]!;
  const fill = rowPtr.slice(0, nV);
  const col = new Uint32Array(2 * nE), edgeOf = new Uint32Array(2 * nE);
  for (let e = 0; e < nE; e++) {
    const a = edgeA[e]!, b = edgeB[e]!;
    col[fill[a]!] = b; edgeOf[fill[a]!] = e; fill[a]!++;
    col[fill[b]!] = a; edgeOf[fill[b]!] = e; fill[b]!++;
  }
  return { nV, positions, mass, edgeA, edgeB, edgeCot, edgeLength, rowPtr, col, edgeOf, negativeCotEdges: negative, meanEdge: sumLen / Math.max(1, nE) };
}

/** Row-scaled diffusion operator: dV_i/dt = Σ_k w[k] (V_col[k] − V_i). */
export interface DiffusionOperator {
  rowPtr: Uint32Array;
  col: Uint32Array;
  /** w[k] = cot_e · D_e / M_i  (1/ms). */
  w: Float32Array;
  /** Gershgorin bound on the spectral radius: 2·max_i Σ_k w[k]. */
  spectralBound: number;
}

/** Assemble the operator from per-edge diffusivities D_e (mm²/ms). */
export function buildDiffusion(g: TissueGeometry, edgeD: Float32Array): DiffusionOperator {
  const w = new Float32Array(g.col.length);
  let maxRow = 0;
  for (let i = 0; i < g.nV; i++) {
    let s = 0;
    const m = g.mass[i]! > 0 ? g.mass[i]! : 1;
    for (let k = g.rowPtr[i]!; k < g.rowPtr[i + 1]!; k++) {
      const e = g.edgeOf[k]!;
      const val = (g.edgeCot[e]! * edgeD[e]!) / m;
      w[k] = val;
      s += val;
    }
    maxRow = Math.max(maxRow, s);
  }
  return { rowPtr: g.rowPtr, col: g.col, w, spectralBound: 2 * maxRow };
}

/** Largest stable forward-Euler diffusion step (ms), with a safety factor. */
export function stableDiffusionDt(op: DiffusionOperator, safety = 0.9): number {
  return op.spectralBound > 0 ? (safety * 2) / op.spectralBound : Infinity;
}
