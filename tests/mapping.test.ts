import { beforeAll, describe, expect, it } from 'vitest';
import { annotate } from '../src/core/mapping/annotate';
import { MapInterpolator } from '../src/core/mapping/interpolate';
import { MappingSession, type RecordedBeat } from '../src/core/mapping/session';
import { SpatialGrid } from '../src/core/mesh/spatial';
import { hexSheet } from '../src/core/mesh/primitives';
import { computeVertexNormals } from '../src/core/mesh/topology';
import { calibrateDiffusivity } from '../src/core/ep/calibrate';
import { createIonicModel } from '../src/core/ep/ionic';
import { CpuBackend } from '../src/core/ep/solver-cpu';
import { Simulation } from '../src/core/ep/simulation';
import { PRESETS, buildTissue, sinusSites } from '../src/core/ep/tissue';
import { buildLeadField, buildSourceGeometry, DEFAULT_INTRACARDIAC, type LeadField } from '../src/core/signals/leadfield';
import { buildCsCatheter } from '../src/core/catheter/cs';
import { rovingPose, DEFAULT_ROVING } from '../src/core/catheter/roving';
import { ElectrodeNoise, DEFAULT_NOISE } from '../src/core/signals/noise';
import { BIPOLAR_BAND, FilterChain, UNIPOLAR_BAND } from '../src/core/signals/filters';
import { detectActivations } from '../src/core/signals/detect';
import { getV, dist } from '../src/core/math/vec3';
import { pearson } from './ep-helpers';
import { defaultAtrium } from './helpers';
import { readFileSync, readdirSync } from 'node:fs';

const FS = 2000;

/** Synthetic window: unipolar downstroke (QS-like) at `latMs`, bipolar biphasic spike, ref spike at 0. */
function synthWindow(latMs: number, opts: { fractionated?: boolean; double?: number } = {}) {
  const pre = 350, n = 1401;
  const t = (i: number) => (i - 700) / 2;
  const ref = new Float32Array(n), uni = new Float32Array(n), bip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ref[i] = Math.exp(-((t(i) / 1.5) ** 2));
    uni[i] = -1.5 / (1 + Math.exp(-(t(i) - latMs) / 1.2));
    const bp = (tc: number, a: number) => a * (-(t(i) - tc) / 2) * Math.exp(-(((t(i) - tc) / 2) ** 2));
    bip[i] = bp(latMs, 1);
    if (opts.double) bip[i] += bp(latMs + opts.double, 0.8);
    if (opts.fractionated) for (let k = 1; k <= 6; k++) bip[i] += bp(latMs + 9 * k, 0.5 + 0.1 * (k % 2));
  }
  return { fs: FS, preMs: pre, ref, uni, bip };
}

describe('EGM annotation', () => {
  it('finds LAT at the steepest unipolar downstroke (±0.5 ms) and at the bipolar peak', () => {
    for (const lat of [-40, 12.3, 75]) {
      const w = synthWindow(lat);
      expect(Math.abs(annotate(w, { start: -100, end: 150 }, 'unipolar').lat - lat)).toBeLessThan(0.5);
      expect(Math.abs(annotate(w, { start: -100, end: 150 }, 'bipolar').lat - lat)).toBeLessThan(2.5);
    }
  });

  it('respects the window of interest', () => {
    const w = synthWindow(120);
    const a = annotate(w, { start: -100, end: 60 }, 'unipolar');
    expect(a.lat).toBeLessThanOrEqual(60);
    expect(a.bipolarVoltage).toBeLessThan(0.3);
  });

  it('flags double potentials and fractionation, not normal EGMs', () => {
    const woi = { start: -100, end: 150 };
    const normal = annotate(synthWindow(10), woi, 'unipolar');
    expect(normal.doublePotential).toBe(false);
    expect(normal.fractionated).toBe(false);
    expect(normal.deflections).toBeLessThanOrEqual(3);
    expect(annotate(synthWindow(10, { double: 45 }), woi, 'unipolar').doublePotential).toBe(true);
    const frac = annotate(synthWindow(10, { fractionated: true }), woi, 'unipolar');
    expect(frac.fractionated).toBe(true);
    expect(frac.deflections).toBeGreaterThanOrEqual(6);
  });
});

describe('geodesic interpolation', () => {
  const s = hexSheet(40, 40, 1);
  const n = s.positions.length / 3;
  const normals = computeVertexNormals(s.positions, s.indices);
  const interp = new MapInterpolator(s.positions, normals, s.indices);
  const grid = new SpatialGrid(s.positions, 4);
  const pts = [] as Array<{ id: number; vertex: number; location: [number, number, number]; value: number }>;
  let id = 1;
  for (let x = 4; x <= 36; x += 4) for (let y = 4; y <= 36; y += 4) {
    const v = grid.nearest([x, y, 0]).index;
    pts.push({ id: id++, vertex: v, location: [x, y, 1.5], value: 2 * x + y });
  }

  it('reproduces a linear field between points and leaves distant vertices unmapped', () => {
    // Interior vertices are ≤ 2.9 mm from a point; the sheet corners are 5.7 mm away.
    const out = interp.interpolate(pts, { fillThreshold: 5 });
    let worst = 0, mapped = 0;
    for (let i = 0; i < n; i++) {
      const x = s.positions[3 * i]!, y = s.positions[3 * i + 1]!;
      if (x > 6 && x < 34 && y > 6 && y < 34) {
        expect(Number.isFinite(out[i]!)).toBe(true);
        worst = Math.max(worst, Math.abs(out[i]! - (2 * x + y)));
        mapped++;
      }
    }
    expect(worst).toBeLessThan(6); // IDW flattens gradients between samples (< one sample spacing × slope)
    // Corners beyond the fill threshold stay unmapped.
    expect(Number.isNaN(out[grid.nearest([0, 0, 0]).index]!)).toBe(true);
    expect(mapped).toBeGreaterThan(500);
  });

  it('a larger fill threshold maps more of the surface', () => {
    const count = (f: number) => Array.from(interp.interpolate(pts, { fillThreshold: f })).filter(Number.isFinite).length;
    expect(count(12)).toBeGreaterThan(count(3));
  });
});

describe('mapping session', () => {
  const s = hexSheet(20, 20, 1);
  const grid = new SpatialGrid(s.positions, 4);
  const beat = (pos: number[], cl: number, sd = 0.3): RecordedBeat => {
    const w = synthWindow(20);
    return { refTime: 1000, cl, fs: FS, preMs: 350, ref: w.ref, catheter: 'ablation', electrodes: [{ name: 'MAP 1', position: pos, uni: w.uni, bip: w.bip }], force: 15, stability: { positionSd: sd, forceMin: 10, forceMax: 20, stable: sd < 1 } };
  };

  it('auto-acquire applies stability, CL, projection and spacing filters; manual acquire does not', () => {
    const m = new MappingSession(grid);
    for (let i = 0; i < 4; i++) m.observe(beat([10, 10, 1], 800));
    expect(m.acquire(beat([10, 10, 1], 800), 'auto').length).toBe(1);
    expect(m.acquire(beat([10.5, 10, 1], 800), 'auto').length).toBe(0); // too close
    expect(m.acquire(beat([5, 5, 1], 650), 'auto').length).toBe(0); // CL mismatch
    expect(m.acquire(beat([5, 5, 1], 800, 2.5), 'auto').length).toBe(0); // unstable
    expect(m.acquire(beat([5, 5, 9], 800), 'auto').length).toBe(0); // off surface
    expect(m.acquire(beat([5, 5, 9], 800, 2.5), 'manual').length).toBe(1);
    expect(m.mapPoints().length).toBe(1); // the off-surface manual point is excluded from maps
  });

  it('supports re-annotation, tags, deletion and undo', () => {
    const m = new MappingSession(grid);
    const [p] = m.acquire(beat([10, 10, 1], 800), 'manual');
    m.setLat(p!.id, 33);
    expect(m.get(p!.id)!.ann.lat).toBe(33);
    m.toggleTag(p!.id, 'scar');
    m.remove([p!.id]);
    expect(m.points.length).toBe(0);
    m.undo(); // delete
    m.undo(); // tag
    expect(m.get(p!.id)!.tags).toEqual([]);
    m.undo(); // annotate
    expect(Math.abs(m.get(p!.id)!.ann.lat - 20)).toBeLessThan(0.5);
    m.reannotateAll({ woi: { start: -100, end: 10 } });
    expect(m.get(p!.id)!.ann.lat).toBeLessThanOrEqual(10);
  });
});

describe('ground-truth firewall', () => {
  it('the mapping module imports nothing from the solver or tissue model', () => {
    const dir = new URL('../src/core/mapping/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).toMatch(/^(\.\/|\.\.\/mesh\/|\.\.\/math\/|\.\.\/signals\/(detect|filters))/);
    }
  });
});

describe('dense LAT map vs ground truth (reaction–diffusion sinus rhythm)', () => {
  const { mesh } = defaultAtrium();
  let result: { r: number; earliestErr: number; mappedFraction: number; nPoints: number; rBip: number };

  beforeAll(async () => {
    const p = PRESETS.healthy;
    const tissue = buildTissue(mesh, p, 1);
    const model = createIonicModel(p.ionic);
    const cal = await calibrateDiffusivity(p.ionic, p.targetCv, { h: tissue.geom.meanEdge, dt: model.recommendedDt });
    const n = tissue.geom.nV;
    const be = new CpuBackend({ geom: tissue.geom, model, edgeD: tissue.substrate.edgeDiffusivity(cal.D), apdScale: tissue.substrate.apdScale, excitable: tissue.substrate.excitable(), siteOf: new Int32Array(n).fill(-1), dt: model.recommendedDt });
    const src = buildSourceGeometry(mesh.positions, mesh.indices, { thickness: mesh.wallThickness, fibrosisDepth: tissue.substrate.fibrosisDepth, excitable: tissue.substrate.excitable() });
    // ~250 evenly spaced sites by farthest-point sampling.
    const sites: number[] = [0];
    const dmin = new Float64Array(n).fill(Infinity);
    for (let k = 1; k < 250; k++) {
      const last = sites[sites.length - 1]!;
      let far = 0;
      for (let i = 0; i < n; i++) {
        dmin[i] = Math.min(dmin[i]!, dist(getV(mesh.positions, i), getV(mesh.positions, last)));
        if (dmin[i]! > dmin[far]!) far = i;
      }
      sites.push(far);
    }
    const cs = buildCsCatheter(mesh);
    const rows: LeadField[] = [buildLeadField(src, cs.electrodes[6]!, DEFAULT_INTRACARDIAC), buildLeadField(src, cs.electrodes[7]!, DEFAULT_INTRACARDIAC)];
    const poses = sites.map((v) => rovingPose(getV(mesh.positions, v), getV(mesh.normals, v), { ...DEFAULT_ROVING, angle: 0 }, 20));
    for (const pose of poses) rows.push(buildLeadField(src, pose.electrodes[0]!, DEFAULT_INTRACARDIAC), buildLeadField(src, pose.electrodes[1]!, DEFAULT_INTRACARDIAC));
    be.setLeadFields(rows, Math.round(1000 / FS / model.recommendedDt));
    const sim = new Simulation(be, model.recommendedDt);
    sinusSites(mesh).forEach((s, k) => {
      sim.schedule.addSite({ name: s.name, vertices: s.vertices, amplitude: 0.5, duration: 2 });
      sim.schedule.trains.push({ site: k, start: 1 + s.delay, period: 800, count: 2 });
    });
    sim.markSitesChanged();
    await sim.advance(1250);
    const smp = be.drainSamples();
    const ns = smp.times.length;
    // Recording chain: per-electrode noise, then referencing and filtering.
    const noise = rows.map((_, r) => new ElectrodeNoise(DEFAULT_NOISE, 100 + r));
    const raw = Array.from({ length: rows.length }, (_, r) => Float32Array.from({ length: ns }, (_, i) => smp.data[i * smp.rows + r]! + noise[r]!.sample(smp.times[i]!)));
    const filt = (x: Float32Array, band: typeof BIPOLAR_BAND) => { const f = new FilterChain(band, FS); return x.map((v) => f.process(v)); };
    const csBip = filt(raw[0]!.map((v, i) => v - raw[1]![i]!), BIPOLAR_BAND);
    const refs = detectActivations(csBip, FS).filter((i) => smp.times[i]! > 700);
    const r0 = refs[0]!;
    const pre = 700, len = 1401;
    const win = (x: Float32Array) => x.slice(r0 - pre, r0 - pre + len);
    const grid = new SpatialGrid(mesh.positions, 4);
    const session = new MappingSession(grid);
    poses.forEach((pose, k) => {
      const uni = filt(raw[2 + 2 * k]!, UNIPOLAR_BAND);
      const bip = filt(raw[2 + 2 * k]!.map((v, i) => v - raw[3 + 2 * k]![i]!), BIPOLAR_BAND);
      session.acquire({ refTime: smp.times[r0]!, cl: 800, fs: FS, preMs: 350, ref: win(csBip), catheter: 'ablation', electrodes: [{ name: 'MAP 1', position: [...pose.tipEnd], uni: win(uni), bip: win(bip) }], force: 20, stability: { positionSd: 0.2, forceMin: 15, forceMax: 25, stable: true } }, 'manual');
    });
    // Ground truth: second-beat activation times.
    const gt = be.readActivation().last;
    const interp = new MapInterpolator(mesh.positions, mesh.normals, mesh.indices);
    const pts = session.mapPoints().map((q) => ({ id: q.id, vertex: q.vertex, location: q.location, value: q.ann.lat }));
    const lat = interp.interpolate(pts, { fillThreshold: 15 });
    const xs: number[] = [], ys: number[] = [];
    let earliest = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(lat[i]!)) continue;
      xs.push(lat[i]!); ys.push(gt[i]!);
      if (earliest < 0 || lat[i]! < lat[earliest]!) earliest = i;
    }
    let trueOrigin = 0;
    for (let i = 0; i < n; i++) if (gt[i]! < gt[trueOrigin]!) trueOrigin = i;
    session.reannotateAll({ latMethod: 'bipolar' });
    const latB = interp.interpolate(session.mapPoints().map((q) => ({ id: q.id, vertex: q.vertex, location: q.location, value: q.ann.lat })), { fillThreshold: 15 });
    const xb: number[] = [], yb: number[] = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(latB[i]!)) { xb.push(latB[i]!); yb.push(gt[i]!); }
    result = {
      r: pearson(xs, ys),
      earliestErr: dist(getV(mesh.positions, earliest), getV(mesh.positions, trueOrigin)),
      mappedFraction: xs.length / n,
      nPoints: pts.length,
      rBip: pearson(xb, yb),
    };
    console.log('dense map', JSON.stringify(result));
  });

  it('interpolated LAT correlates with true activation (r > 0.95) over a well-covered map', () => {
    expect(result.nPoints).toBeGreaterThan(200);
    expect(result.mappedFraction).toBeGreaterThan(0.9);
    expect(result.r).toBeGreaterThan(0.95);
  });

  it('the earliest mapped site is within 5 mm of the true origin', () => {
    expect(result.earliestErr).toBeLessThan(5);
  });

  it('bipolar-peak annotation also tracks activation (r > 0.9)', () => {
    expect(result.rBip).toBeGreaterThan(0.9);
  });
});

describe('end to end: engine beat windows → auto-acquisition → LAT', () => {
  it('auto-acquires only settled beats and annotates LAT within a few ms of the true activation', async () => {
    const { SimEngine } = await import('../src/engine/engine');
    const { DEFAULT_SIM_CONFIG } = await import('../src/engine/protocol');
    const { fastMarching } = await import('../src/core/ep/eikonal');
    const { Rng } = await import('../src/core/rng');
    const { mesh } = defaultAtrium();
    const beats: import('../src/engine/protocol').BeatWindow[] = [];
    const eng = new SimEngine((m) => { if (m.type === 'beat') beats.push(m.beat); });
    await eng.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'eikonal' });
    await eng.setRovingConfig({ type: 'ablation', force: 20, angle: 0 });
    const session = new MappingSession(new SpatialGrid(mesh.positions, 4));
    const rng = new Rng(11);
    let rejectedMoving = 0;
    for (let k = 0; k < 8; k++) {
      await eng.placeRoving(rng.int(0, mesh.region.length));
      beats.length = 0;
      await eng.step(2400);
      for (const b of beats) {
        session.observe(b);
        if (session.check(b, b.electrodes[0]!.position).reasons.includes('catheter moved during this beat')) rejectedMoving++;
        session.acquire(b, 'auto');
      }
    }
    expect(rejectedMoving).toBeGreaterThan(0); // beats spanning a relocation are refused
    expect(session.points.length).toBeGreaterThanOrEqual(6);
    const T = fastMarching(mesh.positions, mesh.indices, new Float32Array(mesh.region.length).fill(0.75), sinusSites(mesh).flatMap((s) => Array.from(s.vertices, (v) => ({ vertex: v, t0: s.delay }))));
    const lat = session.points.map((p) => p.ann.lat), gt = session.points.map((p) => T[p.vertex]!);
    const off = gt.reduce((a, g, i) => a + g - lat[i]!, 0) / gt.length;
    const err = lat.map((l, i) => Math.abs(l + off - gt[i]!)).sort((a, b) => a - b);
    expect(err[err.length >> 1]!).toBeLessThan(2);
    expect(err[err.length - 1]!).toBeLessThan(6);
  });
});
