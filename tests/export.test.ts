import { describe, expect, it } from 'vitest';
import { exportWindow, exportMesh, meshFields, pointRecords, toCsv, toPointsJson, VTK_MISSING } from '../src/core/export/dataset';
import { buildLabels, fibrosisDepthClass } from '../src/core/export/labels';
import { buildGpZones } from '../src/core/ep/autonomic';
import { PRESETS, buildTissue } from '../src/core/ep/tissue';
import { buildScenario } from '../src/core/scenarios/scenarios';
import { AblationController, DEFAULT_ABLATION } from '../src/core/ablation/controller';
import { parsePly } from '../src/core/mesh/io/ply';
import { parseVtk } from '../src/core/mesh/io/vtk';
import { getV } from '../src/core/math/vec3';
import { runBatch, DEFAULT_BATCH } from '../src/engine/batch';
import type { MapPoint, Annotation } from '../src/core/mapping/types';
import { defaultAtrium } from './helpers';

const ann: Annotation = { lat: 12.5, method: 'unipolar', bipolarVoltage: 1.2, unipolarVoltage: 3.4, deflections: 2, duration: 20, fractionated: false, doublePotential: false, refOffset: 0 };

function fakePoint(id: number, vertex: number, location: [number, number, number]): MapPoint {
  const fs = 2000, len = 1401;
  const ramp = Float32Array.from({ length: len }, (_, i) => i / 1000);
  return { id, time: 1000 + id, location, vertex, projectionDistance: 0.4, catheter: 'ablation', electrode: 'MAP 1', force: 12, stable: true, positionSd: 0.3, cl: 800, window: { fs, preMs: 350, ref: ramp, uni: ramp, bip: ramp }, auto: ann, ann, tags: ['a', 'b'], excluded: false };
}

describe('dataset export', () => {
  const { mesh } = defaultAtrium();

  it('cuts and resamples EGM windows', () => {
    const x = Float32Array.from({ length: 1401 }, (_, i) => i);
    const w2 = exportWindow(x, 2000, 350, { preMs: 200, postMs: 300, fs: 2000 });
    expect(w2).toHaveLength(1001);
    expect(w2[0]).toBe(300); // 150 ms after the window start, at 2 kHz
    const w1 = exportWindow(x, 2000, 350, { preMs: 200, postMs: 300, fs: 1000 });
    expect(w1).toHaveLength(500);
    expect(w1[0]).toBe(300.5); // two-sample average
  });

  it('labels: fibrosis depth classes, lesion status, GP zones, critical-site distance', () => {
    expect([fibrosisDepthClass(0, 0.9), fibrosisDepthClass(0.1, 0.2), fibrosisDepthClass(0.1, 0.5), fibrosisDepthClass(0.2, 0.9)]).toEqual([0, 1, 2, 3]);
    const sc = buildScenario(mesh, 'focal', 2);
    const tissue = buildTissue(mesh, PRESETS.persistent, 1);
    const ctl = new AblationController(mesh, new Uint8Array(mesh.region.length));
    const v = sc.truth.focusVertex!;
    ctl.deliver(v, getV(mesh.positions, v), DEFAULT_ABLATION, 15, 0);
    const zones = buildGpZones(mesh, 1);
    const L = buildLabels(mesh, tissue.substrate, ctl.rasterize(0).kind, zones, { vertices: sc.truth.criticalVertices!, label: sc.truth.criticalLabel! }, { scenario: 'focal', seed: 2 });
    expect(L.criticalLabel).toBe('focus');
    expect(L.criticalDistance[v]).toBe(0);
    expect(L.lesionStatus[v]).toBe(2);
    expect(L.criticalDistance.some((d) => d > 50)).toBe(true);
    expect(L.autonomicZone[zones[0]!.centre]).toBe(0);
    expect(L.fibrosisDepthClass.some((c) => c > 0)).toBe(true);
    expect(L.gpNames).toHaveLength(4);
  });

  it('points to CSV and JSON with ground-truth columns', () => {
    const zones = buildGpZones(mesh, 1);
    const tissue = buildTissue(mesh, PRESETS.healthy, 1);
    const labels = buildLabels(mesh, tissue.substrate, null, zones, null, { scenario: null, seed: 1 });
    const pts = [fakePoint(1, 10, [1, 2, 3]), fakePoint(2, zones[0]!.centre, [4, 5, 6])];
    const recs = pointRecords(pts, mesh, labels, { preMs: 100, postMs: 150, fs: 1000 });
    expect(recs[0]!.egm.uni).toHaveLength(250);
    expect(recs[1]!.gt!.autonomic_zone).toBe('Superior left GP');
    expect(Number.isNaN(recs[0]!.gt!.critical_distance_mm)).toBe(true);
    const csv = toCsv(recs).trim().split('\n');
    expect(csv).toHaveLength(3);
    const header = csv[0]!.split(',');
    expect(header).toContain('gt_lesion_status');
    expect(header).toContain('nx');
    const row = csv[1]!.split(',');
    expect(row[header.indexOf('lat_ms')]).toBe('12.5');
    expect(row[header.indexOf('tags')]).toBe('a|b');
    expect(row[header.indexOf('egm_uni')]!.split(' ')).toHaveLength(250);
    const noGt = toCsv(pointRecords(pts, mesh, null));
    expect(noGt.split('\n')[0]).not.toContain('gt_');
    const json = toPointsJson(recs, { scenario: null, seed: 1, criticalLabel: null, egm: { preMs: 100, postMs: 150, fs: 1000 } });
    expect(json.format).toBe('ostium-points/1');
    expect(JSON.parse(JSON.stringify(json)).points[1].gt.fibrosis_depth_class).toBe('none');
  });

  it('mesh with map values and labels round-trips through PLY and VTK', () => {
    const n = mesh.region.length;
    const lat = Float32Array.from({ length: n }, (_, i) => (i % 7 === 0 ? NaN : i * 0.01));
    const fields = meshFields(mesh, { lat, bipolar: null }, buildLabels(mesh, buildTissue(mesh, PRESETS.healthy, 1).substrate, null, [], null, { scenario: null, seed: 1 }));
    expect(Object.keys(fields)).toContain('map_lat');
    expect(Object.keys(fields)).not.toContain('map_bipolar');
    const ply = parsePly(exportMesh(mesh, fields, 'ply') as Uint8Array);
    expect(ply.positions.length).toBe(mesh.positions.length);
    expect(ply.pointData.map_lat![5]).toBeCloseTo(0.05, 5);
    expect(Number.isNaN(ply.pointData.map_lat![0]!)).toBe(true);
    expect(ply.pointData.region![123]).toBe(mesh.region[123]);
    const vtk = parseVtk(exportMesh(mesh, fields, 'vtk') as string);
    expect(vtk.pointData.map_lat![0]).toBe(VTK_MISSING);
    expect(vtk.pointData.gt_lesion_status).toBeDefined();
    expect(vtk.indices.length).toBe(mesh.indices.length);
  });
});

describe('headless batch generation', () => {
  it('generates seeded cases with labelled points, deterministically', async () => {
    const { mesh } = defaultAtrium();
    const spec = { ...DEFAULT_BATCH, cases: 2, pointsPerCase: 5, seed: 7, backend: 'cpu' as const, randomAutonomic: true, egm: { preMs: 100, postMs: 200, fs: 1000 as const } };
    const a = await runBatch(spec, mesh);
    expect(a.cases).toHaveLength(2);
    for (const c of a.cases) {
      expect(c.points).toHaveLength(5);
      for (const p of c.points) {
        expect(p.egm.bip).toHaveLength(300);
        expect(p.gt).toBeDefined();
        expect(Number.isFinite(p.lat_ms)).toBe(true);
      }
      expect(c.sinusCl).toBeGreaterThan(0);
    }
    expect(a.cases[0]!.seed).not.toBe(a.cases[1]!.seed);
    const b = await runBatch(spec, mesh);
    expect(JSON.stringify(b.cases)).toBe(JSON.stringify(a.cases));
  }, 300_000);
});
