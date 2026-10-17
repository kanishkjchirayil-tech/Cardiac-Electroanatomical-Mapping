import { pushFan, toText, type RawMesh } from './raw';

/**
 * Legacy VTK, ASCII encoding: POLYDATA (POLYGONS) or UNSTRUCTURED_GRID (triangle/polygon cells),
 * with POINT_DATA SCALARS read into pointData.
 */
export function parseVtk(data: ArrayBuffer | Uint8Array | string): RawMesh {
  const lines = toText(data).split(/\r?\n/);
  if (!/^# vtk DataFile/i.test(lines[0] ?? '')) throw new Error('VTK: missing header');
  if ((lines[2] ?? '').trim().toUpperCase() !== 'ASCII') throw new Error('VTK: only ASCII legacy files are supported');
  const tokens = lines.slice(3).join(' ').split(/\s+/).filter((t) => t.length > 0);
  let k = 0;
  const positions: number[] = [];
  const indices: number[] = [];
  const pointData: Record<string, Float32Array> = {};
  let cellTypes: number[] | null = null;
  let cells: number[][] = [];
  let nPoints = 0;
  while (k < tokens.length) {
    const kw = tokens[k++]!.toUpperCase();
    if (kw === 'POINTS') {
      nPoints = parseInt(tokens[k++]!, 10);
      k++; // data type
      for (let i = 0; i < 3 * nPoints; i++) positions.push(Number(tokens[k++]));
    } else if (kw === 'POLYGONS' || kw === 'CELLS' || kw === 'TRIANGLE_STRIPS') {
      const n = parseInt(tokens[k++]!, 10);
      k++; // size
      const list: number[][] = [];
      for (let i = 0; i < n; i++) {
        const m = parseInt(tokens[k++]!, 10);
        const poly: number[] = [];
        for (let j = 0; j < m; j++) poly.push(parseInt(tokens[k++]!, 10));
        list.push(poly);
      }
      if (kw === 'TRIANGLE_STRIPS') {
        for (const s of list) for (let i = 0; i + 2 < s.length; i++) indices.push(...(i % 2 ? [s[i + 1]!, s[i]!, s[i + 2]!] : [s[i]!, s[i + 1]!, s[i + 2]!]));
      } else cells = cells.concat(list);
    } else if (kw === 'CELL_TYPES') {
      const n = parseInt(tokens[k++]!, 10);
      cellTypes = [];
      for (let i = 0; i < n; i++) cellTypes.push(parseInt(tokens[k++]!, 10));
    } else if (kw === 'SCALARS') {
      const name = tokens[k++]!;
      k++; // type
      let comps = 1;
      if (!/^LOOKUP_TABLE$/i.test(tokens[k]!)) comps = parseInt(tokens[k++]!, 10);
      if (/^LOOKUP_TABLE$/i.test(tokens[k]!)) k += 2;
      const arr = new Float32Array(nPoints);
      for (let i = 0; i < nPoints; i++) {
        arr[i] = Number(tokens[k]);
        k += comps;
      }
      pointData[name] = arr;
    } else if (kw === 'POINT_DATA' || kw === 'CELL_DATA') {
      k++;
    }
    // Other keywords (DATASET, VERTICES, LINES, FIELD …) are skipped token-by-token.
  }
  cells.forEach((c, i) => {
    const type = cellTypes ? cellTypes[i] : 7;
    if (type === 5 || type === 7 || type === 9) pushFan(indices, c); // triangle, polygon, quad
  });
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), pointData };
}

export function writeVtk(
  mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> },
  pointData: Record<string, ArrayLike<number>> = {},
  title = 'Ostium educational simulator export (LPS, mm)',
): string {
  const nV = mesh.positions.length / 3, nF = mesh.indices.length / 3;
  const out: string[] = ['# vtk DataFile Version 3.0', title, 'ASCII', 'DATASET POLYDATA', `POINTS ${nV} float`];
  for (let v = 0; v < nV; v++) out.push(`${mesh.positions[3 * v]} ${mesh.positions[3 * v + 1]} ${mesh.positions[3 * v + 2]}`);
  out.push(`POLYGONS ${nF} ${4 * nF}`);
  for (let f = 0; f < nF; f++) out.push(`3 ${mesh.indices[3 * f]} ${mesh.indices[3 * f + 1]} ${mesh.indices[3 * f + 2]}`);
  const names = Object.keys(pointData);
  if (names.length) {
    out.push(`POINT_DATA ${nV}`);
    for (const n of names) {
      out.push(`SCALARS ${n.replace(/\s+/g, '_')} float 1`, 'LOOKUP_TABLE default');
      const a = pointData[n]!;
      for (let v = 0; v < nV; v++) out.push(String(a[v]));
    }
  }
  return out.join('\n') + '\n';
}
