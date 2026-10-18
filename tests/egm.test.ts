import { beforeAll, describe, expect, it } from 'vitest';
import { calibrateDiffusivity } from '../src/core/ep/calibrate';
import { createIonicModel } from '../src/core/ep/ionic';
import { CpuBackend } from '../src/core/ep/solver-cpu';
import { Simulation } from '../src/core/ep/simulation';
import { Substrate } from '../src/core/ep/substrate';
import { buildGeometry } from '../src/core/ep/fem';
import { PRESETS, buildTissue, sinusSites } from '../src/core/ep/tissue';
import { buildLeadField, buildSourceGeometry, DEFAULT_INTRACARDIAC, type LeadField } from '../src/core/signals/leadfield';
import { ECG_ELECTRODES, K_TORSO, TORSO_GAIN } from '../src/core/signals/ecg';
import { rovingPose, DEFAULT_ROVING } from '../src/core/catheter/roving';
import { Region } from '../src/core/mesh/regions';
import { getV, type Vec3 } from '../src/core/math/vec3';
import type { SurfaceMesh } from '../src/core/mesh/types';
import { defaultAtrium } from './helpers';

/** Vertices of a region ordered by distance to the region centroid (central ones first). */
function centralVertices(mesh: SurfaceMesh, r: Region, k: number, spacingMm = 6): number[] {
  const ids: number[] = [];
  const c: Vec3 = [0, 0, 0];
  mesh.region.forEach((x, i) => { if (x === r) { ids.push(i); for (let q = 0; q < 3; q++) c[q] += mesh.positions[3 * i + q]!; } });
  for (let q = 0; q < 3; q++) c[q] /= ids.length;
  const d = (i: number) => Math.hypot(mesh.positions[3 * i]! - c[0], mesh.positions[3 * i + 1]! - c[1], mesh.positions[3 * i + 2]! - c[2]);
  ids.sort((a, b) => d(a) - d(b));
  const out: number[] = [];
  for (const i of ids) {
    if (out.every((j) => Math.hypot(...[0, 1, 2].map((q) => mesh.positions[3 * i + q]! - mesh.positions[3 * j + q]!) as [number, number, number]) > spacingMm)) out.push(i);
    if (out.length === k) break;
  }
  return out;
}

interface Probe { name: string; vertex: number; force: number }

/** One reaction–diffusion sinus beat, sampling the given probes (MAP 1, MAP 2 each) and ECG electrodes. */
async function beat(mesh: SurfaceMesh, substrate: Substrate, ionic = PRESETS.healthy.ionic, cv = 0.75, probes: Probe[]) {
  const model = createIonicModel(ionic);
  const geom = substrate.geom;
  const cal = await calibrateDiffusivity(ionic, cv, { h: geom.meanEdge, dt: model.recommendedDt });
  const n = geom.nV;
  const be = new CpuBackend({ geom, model, edgeD: substrate.edgeDiffusivity(cal.D), apdScale: substrate.apdScale, excitable: substrate.excitable(), siteOf: new Int32Array(n).fill(-1), dt: model.recommendedDt });
  const src = buildSourceGeometry(mesh.positions, mesh.indices, { thickness: mesh.wallThickness, fibrosisDepth: substrate.fibrosisDepth, excitable: substrate.excitable() });
  const rows: LeadField[] = [];
  for (const p of probes) {
    const pose = rovingPose(getV(mesh.positions, p.vertex), getV(mesh.normals, p.vertex), { ...DEFAULT_ROVING, angle: 0 }, p.force);
    rows.push(buildLeadField(src, pose.electrodes[0]!, DEFAULT_INTRACARDIAC), buildLeadField(src, pose.electrodes[1]!, DEFAULT_INTRACARDIAC));
  }
  for (const pos of Object.values(ECG_ELECTRODES)) rows.push(buildLeadField(src, pos, { K: K_TORSO * TORSO_GAIN, cutoff: Infinity }));
  be.setLeadFields(rows, Math.round(0.5 / model.recommendedDt));
  const sim = new Simulation(be, model.recommendedDt);
  sinusSites(mesh).forEach((s, k) => {
    sim.schedule.addSite({ name: s.name, vertices: s.vertices, amplitude: 0.5, duration: 2 });
    sim.schedule.trains.push({ site: k, start: 1 + s.delay, period: Infinity, count: 1 });
  });
  sim.markSitesChanged();
  await sim.advance(200); // depolarization only (repolarization starts > 200 ms)
  const s = be.drainSamples();
  const col = (r: number) => Array.from({ length: s.times.length }, (_, i) => s.data[i * s.rows + r]!);
  const out: Record<string, { uni: number[]; bip: number[] }> = {};
  probes.forEach((p, k) => {
    const u1 = col(2 * k), u2 = col(2 * k + 1);
    out[p.name] = { uni: u1, bip: u1.map((x, i) => x - u2[i]!) };
  });
  const e0 = 2 * probes.length;
  const [ra, la, ll, v1] = [0, 1, 2, 3].map((q) => col(e0 + q));
  const wct = ra!.map((x, i) => (x + la![i]! + ll![i]!) / 3);
  return { probes: out, ecg: { II: ll!.map((x, i) => x - ra![i]!), V1: v1!.map((x, i) => x - wct[i]!) }, act: be.readActivation() };
}

const pp = (x: number[]) => Math.max(...x) - Math.min(...x);
const median = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)]!;

describe('electrograms from the simulated tissue', () => {
  const { mesh } = defaultAtrium();
  const posterior = centralVertices(mesh, Region.Posterior, 3);
  const anterior = centralVertices(mesh, Region.Anterior, 3);
  const lateral = centralVertices(mesh, Region.Lateral, 1)[0]!;
  const bb = sinusSites(mesh)[0]!.vertices[0]!;
  const probes: Probe[] = [
    ...posterior.map((v, i) => ({ name: `post${i}`, vertex: v, force: 20 })),
    ...anterior.map((v, i) => ({ name: `ant${i}`, vertex: v, force: 20 })),
    { name: 'bb', vertex: bb, force: 20 },
    { name: 'lat', vertex: lateral, force: 20 },
    { name: 'lat-float', vertex: lateral, force: 0 },
  ];
  let healthy: Awaited<ReturnType<typeof beat>>;
  let scarred: Awaited<ReturnType<typeof beat>>;

  beforeAll(async () => {
    healthy = await beat(mesh, buildTissue(mesh, PRESETS.healthy, 1).substrate, undefined, undefined, probes);
    // Dense (70 %) diffuse fibrosis confined to the posterior wall: a low-voltage "scar" region.
    const geom = buildGeometry(mesh.positions, mesh.indices);
    const dens = Float32Array.from(mesh.region, (r) => (r === Region.Posterior ? 0.7 : 0));
    scarred = await beat(mesh, new Substrate(geom, { seed: 2, fibrosisDensity: dens, fibrosisPattern: 'diffuse' }), undefined, undefined, probes);
  });

  it('healthy bipolar amplitudes are in the normal atrial range (> 0.5 mV)', () => {
    for (const k of ['post0', 'post1', 'post2', 'ant0', 'ant1', 'ant2', 'lat']) expect(pp(healthy.probes[k]!.bip), k).toBeGreaterThan(0.5);
  });

  it('bipolar amplitude falls in fibrotic scar (< 50 % of the same sites when healthy)', () => {
    const ratios = posterior.map((_, i) => pp(scarred.probes[`post${i}`]!.bip) / pp(healthy.probes[`post${i}`]!.bip));
    expect(median(ratios)).toBeLessThan(0.5);
    // Healthy anterior wall in the scarred atrium is unaffected (within 25 %).
    const ant = anterior.map((_, i) => pp(scarred.probes[`ant${i}`]!.bip) / pp(healthy.probes[`ant${i}`]!.bip));
    expect(Math.abs(median(ant) - 1)).toBeLessThan(0.25);
  });

  it('the persistent-AF substrate has lower bipolar voltage than healthy tissue', async () => {
    const p = PRESETS.persistent;
    const remodeled = await beat(mesh, buildTissue(mesh, p, 1).substrate, p.ionic, p.targetCv, probes.slice(0, 6));
    const hv = probes.slice(0, 6).map((q) => pp(healthy.probes[q.name]!.bip));
    const rv = probes.slice(0, 6).map((q) => pp(remodeled.probes[q.name]!.bip));
    expect(median(rv)).toBeLessThan(0.75 * median(hv));
  });

  it('unipolar EGM is a QS complex at the earliest activation site and RS where the wave passes by', () => {
    const qs = healthy.probes.bb!.uni;
    expect(Math.max(...qs)).toBeLessThan(0.1 * Math.abs(Math.min(...qs)));
    expect(Math.min(...qs)).toBeLessThan(-0.5);
    const rs = healthy.probes.lat!.uni;
    const iMax = rs.indexOf(Math.max(...rs)), iMin = rs.indexOf(Math.min(...rs));
    expect(Math.max(...rs)).toBeGreaterThan(0.25);
    expect(Math.min(...rs)).toBeLessThan(-0.25);
    expect(iMax).toBeLessThan(iMin); // R before S
  });

  it('poor contact lowers local bipolar amplitude', () => {
    expect(pp(healthy.probes['lat-float']!.bip)).toBeLessThan(0.7 * pp(healthy.probes.lat!.bip));
  });

  it('surface ECG: small LA P-wave component in II, terminal negativity in V1', () => {
    const ii = pp(healthy.ecg.II);
    expect(ii).toBeGreaterThan(0.03);
    expect(ii).toBeLessThan(0.2);
    const v1 = healthy.ecg.V1;
    expect(Math.min(...v1)).toBeLessThan(-0.03);
  });
});
