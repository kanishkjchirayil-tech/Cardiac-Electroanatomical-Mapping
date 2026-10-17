import { generateAtrium } from '../src/core/mesh/atrium';
import { REGIONS } from '../src/core/mesh/regions';
const t = performance.now();
const r = generateAtrium({ remeshIterations: Number(process.env.IT ?? 10), onProgress: (s) => console.log('stage', s, ((performance.now() - t) / 1000).toFixed(2)) });
console.log(JSON.stringify(r.quality, null, 1));
console.log(r.timingsMs);
console.log(r.mesh.boundaryLoops.map((l) => `${l.label}:${l.vertices.length}`).join(' '));
const counts = new Map<number, number>();
r.mesh.region.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
console.log([...counts].sort((a, b) => a[0] - b[0]).map(([k, c]) => `${REGIONS[k]!.name}=${c}`).join(', '));
let mn = 9, mx = 0, s = 0;
r.mesh.wallThickness.forEach((x) => { mn = Math.min(mn, x); mx = Math.max(mx, x); s += x; });
console.log('thickness', mn.toFixed(2), mx.toFixed(2), (s / r.mesh.wallThickness.length).toFixed(2));
// fold check vs SDF normal
let folds = 0;
const P = r.mesh.positions, I = r.mesh.indices;
for (let i = 0; i < I.length; i += 3) {
  const a = I[i]!, b = I[i + 1]!, c = I[i + 2]!;
  const u = [P[3*b]!-P[3*a]!, P[3*b+1]!-P[3*a+1]!, P[3*b+2]!-P[3*a+2]!];
  const w = [P[3*c]!-P[3*a]!, P[3*c+1]!-P[3*a+1]!, P[3*c+2]!-P[3*a+2]!];
  const n = [u[1]!*w[2]!-u[2]!*w[1]!, u[2]!*w[0]!-u[0]!*w[2]!, u[0]!*w[1]!-u[1]!*w[0]!];
  const cen: [number,number,number] = [(P[3*a]!+P[3*b]!+P[3*c]!)/3,(P[3*a+1]!+P[3*b+1]!+P[3*c+1]!)/3,(P[3*a+2]!+P[3*b+2]!+P[3*c+2]!)/3];
  const g = r.shape.normal(cen);
  if (n[0]!*g[0]+n[1]!*g[1]+n[2]!*g[2] <= 0) folds++;
}
console.log('folds', folds, 'ostiumT', r.shape.veins.map((_, k) => r.shape.ostiumT(k).toFixed(1)).join(','));
