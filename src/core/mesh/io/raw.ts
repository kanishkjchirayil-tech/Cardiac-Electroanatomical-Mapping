/** Geometry plus optional per-vertex scalar arrays, as read from / written to mesh files. */
export interface RawMesh {
  positions: Float32Array;
  indices: Uint32Array;
  pointData: Record<string, Float32Array>;
}

/** Triangulate a polygon (as a fan) into `out`. */
export function pushFan(out: number[], poly: number[]): void {
  for (let i = 1; i + 1 < poly.length; i++) out.push(poly[0]!, poly[i]!, poly[i + 1]!);
}

export function toText(data: ArrayBuffer | Uint8Array | string): string {
  if (typeof data === 'string') return data;
  return new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));
}
