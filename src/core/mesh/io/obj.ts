import { pushFan, toText, type RawMesh } from './raw';

/** Wavefront OBJ: `v` and `f` records only (texture/normal indices ignored, polygons fan-triangulated). */
export function parseObj(data: ArrayBuffer | Uint8Array | string): RawMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const raw of toText(data).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/);
      pos.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith('f ')) {
      const nv = pos.length / 3;
      const poly = line
        .split(/\s+/)
        .slice(1)
        .map((tok) => {
          const i = parseInt(tok.split('/')[0]!, 10);
          return i < 0 ? nv + i : i - 1;
        });
      pushFan(idx, poly);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), pointData: {} };
}

export function writeObj(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }, comment = 'Ostium mesh (LPS, mm)'): string {
  const lines = [`# ${comment}`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(`f ${mesh.indices[i]! + 1} ${mesh.indices[i + 1]! + 1} ${mesh.indices[i + 2]! + 1}`);
  }
  return lines.join('\n') + '\n';
}
