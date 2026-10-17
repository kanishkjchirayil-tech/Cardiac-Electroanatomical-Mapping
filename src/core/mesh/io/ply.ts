import { pushFan, type RawMesh } from './raw';

type PlyType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';
const TYPE_ALIASES: Record<string, PlyType> = {
  char: 'char', int8: 'char', uchar: 'uchar', uint8: 'uchar',
  short: 'short', int16: 'short', ushort: 'ushort', uint16: 'ushort',
  int: 'int', int32: 'int', uint: 'uint', uint32: 'uint',
  float: 'float', float32: 'float', double: 'double', float64: 'double',
};
const SIZES: Record<PlyType, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

interface PlyProp {
  name: string;
  type: PlyType;
  list?: { countType: PlyType };
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

/** Stanford PLY (ascii, binary_little_endian, binary_big_endian). Extra scalar vertex properties become pointData. */
export function parsePly(data: ArrayBuffer | Uint8Array): RawMesh {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Locate the end of the header.
  const marker = 'end_header';
  let headerEnd = -1;
  for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    if (bytes[i] === 0x65 && new TextDecoder().decode(bytes.subarray(i, i + marker.length)) === marker) {
      let j = i + marker.length;
      if (bytes[j] === 0x0d) j++;
      if (bytes[j] === 0x0a) j++;
      headerEnd = j;
      break;
    }
  }
  if (headerEnd < 0) throw new Error('PLY: missing end_header');
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)).split(/\r?\n/);
  if (header[0]?.trim() !== 'ply') throw new Error('PLY: bad magic');
  let format = 'ascii';
  const elements: PlyElement[] = [];
  for (const line of header) {
    const tok = line.trim().split(/\s+/);
    if (tok[0] === 'format') format = tok[1]!;
    else if (tok[0] === 'element') elements.push({ name: tok[1]!, count: parseInt(tok[2]!, 10), props: [] });
    else if (tok[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new Error('PLY: property before element');
      if (tok[1] === 'list') {
        el.props.push({ name: tok[4]!, type: TYPE_ALIASES[tok[3]!]!, list: { countType: TYPE_ALIASES[tok[2]!]! } });
      } else {
        el.props.push({ name: tok[2]!, type: TYPE_ALIASES[tok[1]!]! });
      }
    }
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const extra: Record<string, number[]> = {};
  const handleVertex = (vals: Record<string, number>, props: PlyProp[]) => {
    positions.push(vals.x!, vals.y!, vals.z!);
    for (const p of props) {
      if (p.list || p.name === 'x' || p.name === 'y' || p.name === 'z') continue;
      (extra[p.name] ??= []).push(vals[p.name]!);
    }
  };

  if (format === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd)).split(/\s+/).filter((s) => s.length > 0);
    let k = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        const vals: Record<string, number> = {};
        let list: number[] | null = null;
        for (const p of el.props) {
          if (p.list) {
            const n = Number(body[k++]);
            list = [];
            for (let j = 0; j < n; j++) list.push(Number(body[k++]));
          } else vals[p.name] = Number(body[k++]);
        }
        if (el.name === 'vertex') handleVertex(vals, el.props);
        else if (el.name === 'face' && list) pushFan(indices, list);
      }
    }
  } else {
    const little = format === 'binary_little_endian';
    if (!little && format !== 'binary_big_endian') throw new Error(`PLY: unsupported format ${format}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = headerEnd;
    const read = (t: PlyType): number => {
      let v: number;
      switch (t) {
        case 'char': v = view.getInt8(off); break;
        case 'uchar': v = view.getUint8(off); break;
        case 'short': v = view.getInt16(off, little); break;
        case 'ushort': v = view.getUint16(off, little); break;
        case 'int': v = view.getInt32(off, little); break;
        case 'uint': v = view.getUint32(off, little); break;
        case 'float': v = view.getFloat32(off, little); break;
        case 'double': v = view.getFloat64(off, little); break;
      }
      off += SIZES[t];
      return v;
    };
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        const vals: Record<string, number> = {};
        let list: number[] | null = null;
        for (const p of el.props) {
          if (p.list) {
            const n = read(p.list.countType);
            list = [];
            for (let j = 0; j < n; j++) list.push(read(p.type));
          } else vals[p.name] = read(p.type);
        }
        if (el.name === 'vertex') handleVertex(vals, el.props);
        else if (el.name === 'face' && list) pushFan(indices, list);
      }
    }
  }
  const pointData: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(extra)) pointData[k] = Float32Array.from(v);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), pointData };
}

/** Write PLY with optional per-vertex float properties. */
export function writePly(
  mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> },
  pointData: Record<string, ArrayLike<number>> = {},
  format: 'ascii' | 'binary' = 'binary',
): Uint8Array {
  const nV = mesh.positions.length / 3, nF = mesh.indices.length / 3;
  const names = Object.keys(pointData).map((n) => n.replace(/\s+/g, '_'));
  const fields = Object.values(pointData);
  const header =
    [
      'ply',
      format === 'ascii' ? 'format ascii 1.0' : 'format binary_little_endian 1.0',
      'comment Ostium educational simulator export (LPS, mm)',
      `element vertex ${nV}`,
      'property float x',
      'property float y',
      'property float z',
      ...names.map((n) => `property float ${n}`),
      `element face ${nF}`,
      'property list uchar int vertex_indices',
      'end_header',
    ].join('\n') + '\n';
  const enc = new TextEncoder();
  if (format === 'ascii') {
    const lines: string[] = [];
    for (let v = 0; v < nV; v++) {
      const row = [mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2], ...fields.map((f) => f[v])];
      lines.push(row.join(' '));
    }
    for (let f = 0; f < nF; f++) lines.push(`3 ${mesh.indices[3 * f]} ${mesh.indices[3 * f + 1]} ${mesh.indices[3 * f + 2]}`);
    return enc.encode(header + lines.join('\n') + '\n');
  }
  const h = enc.encode(header);
  const size = h.length + nV * 4 * (3 + fields.length) + nF * 13;
  const out = new Uint8Array(size);
  out.set(h, 0);
  const view = new DataView(out.buffer);
  let off = h.length;
  for (let v = 0; v < nV; v++) {
    for (let c = 0; c < 3; c++, off += 4) view.setFloat32(off, mesh.positions[3 * v + c]!, true);
    for (const f of fields) {
      view.setFloat32(off, f[v]!, true);
      off += 4;
    }
  }
  for (let f = 0; f < nF; f++) {
    view.setUint8(off++, 3);
    for (let c = 0; c < 3; c++, off += 4) view.setInt32(off, mesh.indices[3 * f + c]!, true);
  }
  return out;
}
