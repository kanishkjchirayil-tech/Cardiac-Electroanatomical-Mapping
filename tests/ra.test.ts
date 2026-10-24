import { describe, expect, it } from 'vitest';
import { generateAtrium } from '../src/core/mesh/atrium';
import { Region } from '../src/core/mesh/regions';
import { edgeStats, vertexAdjacency } from '../src/core/mesh/topology';
import { edgeDijkstra } from '../src/core/mesh/geodesic';
import { PRESETS, buildTissue, sinusSites } from '../src/core/ep/tissue';
import { fastMarching } from '../src/core/ep/eikonal';
import { buildCsCatheter } from '../src/core/catheter/cs';
import { ConductionGraph } from '../src/core/scenarios/topology';
import { MeshTools } from '../src/core/scenarios/geometry';
import { buildScenario } from '../src/core/scenarios/scenarios';
import { SpatialGrid } from '../src/core/mesh/spatial';
import { SimEngine } from '../src/engine/engine';
import { DEFAULT_SIM_CONFIG, type FromWorker, type PacingStatus } from '../src/engine/protocol';
import { along } from './case-helpers';

let cached: ReturnType<typeof generateAtrium> | null = null;
const ra = () => (cached ??= generateAtrium({ chamber: 'RA' }));

describe('right atrium anatomy (stretch goal)', () => {
  it('is a closed manifold shell with SVC, IVC, CS and tricuspid openings', () => {
    const { mesh, quality } = ra();
    expect(mesh.chamber).toBe('RA');
    expect(mesh.boundaryLoops.map((l) => l.label).sort()).toEqual(['CS', 'IVC', 'SVC', 'TV']);
    const e = edgeStats(mesh.indices);
    expect(e.nonManifoldEdges).toBe(0);
    expect(e.duplicateHalfEdges).toBe(0);
    expect(quality.minAngleDeg).toBeGreaterThan(15);
    expect(Math.abs(quality.meanEdge - 0.95)).toBeLessThan(0.1);
    expect(mesh.anatomy!.mitral.radius).toBeGreaterThan(14); // tricuspid annulus ≈ 15–20 mm radius
    expect(mesh.anatomy!.mitral.radius).toBeLessThan(21);
  });

  it('labels every RA structure; the CTI spans 15–40 mm; the crista is the thickest wall', () => {
    const { mesh } = ra();
    const count = (r: Region) => mesh.region.reduce((n, x) => n + (x === r ? 1 : 0), 0);
    for (const r of [Region.RAFreeWall, Region.RAPosterior, Region.RASeptum, Region.CristaTerminalis, Region.CTI, Region.SVC, Region.IVC, Region.RAA, Region.TricuspidAnnulus, Region.CSOstium]) expect(count(r)).toBeGreaterThan(40);
    const adj = vertexAdjacency(mesh.indices, mesh.region.length);
    const ivc = mesh.boundaryLoops.find((l) => l.label === 'IVC')!.vertices;
    const tv = mesh.boundaryLoops.find((l) => l.label === 'TV')!.vertices;
    const dIvcRing = edgeDijkstra(mesh.positions, adj, Array.from(mesh.region.keys()).filter((i) => mesh.region[i] === Region.IVC)).distance;
    const isthmus = Math.min(...Array.from(tv, (v) => dIvcRing[v]!));
    expect(isthmus).toBeGreaterThan(15);
    expect(isthmus).toBeLessThan(40);
    void ivc;
    const mean = (r: Region) => { let s = 0, n = 0; mesh.region.forEach((x, i) => { if (x === r) { s += mesh.wallThickness[i]!; n++; } }); return s / n; };
    expect(mean(Region.CristaTerminalis)).toBeGreaterThan(mean(Region.RAFreeWall) + 1);
    expect(mean(Region.CTI)).toBeGreaterThan(mean(Region.RAFreeWall));
    expect(mesh.region[mesh.anatomy!.ra!.sinusNode]).toBe(Region.CristaTerminalis);
  });

  it('sinus rhythm starts at the sinus node and activates the whole RA in 60–140 ms; the crista block isolates nothing', () => {
    const { mesh } = ra();
    const sites = sinusSites(mesh);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.name).toBe('Sinus node');
    const tissue = buildTissue(mesh, PRESETS.healthy, 1);
    let cut = 0;
    tissue.substrate.edgeScale.forEach((x) => (cut += x === 0 ? 1 : 0));
    expect(cut).toBeGreaterThan(30);
    const g = new ConductionGraph(tissue.geom, tissue.substrate.edgeDiffusivity(0.5), tissue.substrate.excitable());
    const reached = g.reachable(sites[0]!.vertices);
    expect(reached.reduce((a, b) => a + b, 0)).toBe(mesh.region.length);
    const T = fastMarching(mesh.positions, mesh.indices, new Float32Array(mesh.region.length).fill(0.75), Array.from(sites[0]!.vertices, (v) => ({ vertex: v, t0: 0 })));
    const tMax = Math.max(...T);
    expect(tMax).toBeGreaterThan(60);
    expect(tMax).toBeLessThan(140);
  });

  it('the CS catheter passes the ostium: CS 9-10 sit beside the ostium wall, CS 1-8 beyond the chamber', () => {
    const { mesh } = ra();
    const cs = buildCsCatheter(mesh);
    const grid = new SpatialGrid(mesh.positions, 4);
    const d = cs.electrodes.map((p) => grid.nearest(p).distance);
    expect(d[9]!).toBeLessThan(3); // CS 10
    expect(d[8]!).toBeLessThan(3.5); // CS 9
    expect(Math.min(...d.slice(0, 7))).toBeGreaterThan(d[8]!);
  });
});

describe('typical (CTI-dependent) flutter', () => {
  it('the scenario is deterministic per seed, set in the RA, with the isthmus as its critical site', () => {
    const { mesh } = ra();
    const a = buildScenario(mesh, 'typical', 5), b = buildScenario(mesh, 'typical', 5);
    expect(a.truth).toEqual(b.truth);
    expect(a.info.chamber).toBe('RA');
    expect(a.truth.criticalLabel).toBe('cavotricuspid isthmus');
    expect(a.slowZones).toHaveLength(1);
    expect(() => buildScenario(generateAtrium({ targetEdge: 2.5, gridSpacing: 2, remeshIterations: 3 }).mesh, 'typical', 1)).toThrow();
  });

  it('sustains around the tricuspid annulus, entrains from the CTI, and a CTI line terminates it with proven block', async () => {
    const { mesh } = ra();
    const tools = new MeshTools(mesh);
    const msgs: FromWorker[] = [];
    const engine = new SimEngine((m) => msgs.push(m));
    await engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'rd', backend: 'cpu', scenario: { id: 'typical', seed: 3 } });
    const cls: number[] = [];
    const lastPacing = () => ([...msgs].reverse().find((m) => m.type === 'pacing' && m.status) as { status: PacingStatus } | undefined)?.status;
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 250) {
        await engine.step(250);
        for (const m of msgs) if (m.type === 'beat') cls.push(m.beat.cl);
        const keep = msgs.filter((m) => m.type === 'pacing' || m.type === 'report');
        msgs.length = 0;
        msgs.push(...keep.slice(-20));
      }
    };
    const report = async () => {
      await engine.requestReport();
      return ([...msgs].reverse().find((m) => m.type === 'report') as Extract<FromWorker, { type: 'report' }>).report;
    };
    await run(4000);
    const tach = cls.slice(-4);
    expect(tach.every((c) => c > 190 && c < 280)).toBe(true);
    expect((await report()).rhythm).toBe('not-sinus');
    // Entrainment from the middle of the isthmus: in the circuit.
    const isthmus = tools.path(tools.loop('TV'), tools.loop('IVC'));
    const mid = isthmus[Math.floor(isthmus.length / 2)]!;
    await engine.placeRoving(mid);
    await run(1200);
    const tcl = tach.reduce((a, b) => a + b, 0) / tach.length;
    await engine.pace({ site: 'roving', output: 10, protocol: { kind: 'entrain', cl: Math.round(tcl - 20), count: 8 } });
    await run(4500);
    const ent = lastPacing()!;
    expect(ent.entrain).not.toBeNull();
    expect(Math.abs(ent.entrain!.diff)).toBeLessThan(30);
    // CTI line: the isthmus is thick (≈ 3 mm), so deep lesions at 3 mm spacing.
    engine.setAblationSettings({ power: 45, duration: 30, timeScale: 10, edema: false, edemaRecoverySec: 30, gapThreshold: 6 });
    for (const v of along(tools, isthmus, 3)) {
      await engine.placeRoving(v);
      await engine.rfStart(true);
    }
    await run(3000);
    const r = await report();
    expect(r.chamber).toBe('RA');
    expect(r.ctiBlock.durable).toBe(true);
    expect(r.rhythm).toBe('sinus');
    // Proving block: pace from the CS ostium (septal to the line) and record just lateral to it.
    // Without block the lateral isthmus is ≈ 1–2 cm away; with block the wave detours around the annulus.
    const lateral = [...tools.dilate(isthmus, 12)].filter((v) => mesh.region[v] === Region.CTI || mesh.region[v] === Region.RAFreeWall)
      .filter((v) => mesh.positions[3 * v]! < mesh.positions[3 * mid]! - 6)
      .sort((a, b) => tools.distance(a, mid) - tools.distance(b, mid))[0]!;
    await engine.placeRoving(lateral);
    await run(1200);
    await engine.pace({ site: 'cs-proximal', output: 10, protocol: { kind: 'fixed', cl: 600, count: 5 } });
    await run(3600);
    const proof = lastPacing()!;
    const map = proof.intervals.find((i) => i.channel === 'MAP 1-2')!;
    expect(map.ms!).toBeGreaterThan(100);
    expect(map.distance).toBeLessThan(35);
  }, 600_000);
});
