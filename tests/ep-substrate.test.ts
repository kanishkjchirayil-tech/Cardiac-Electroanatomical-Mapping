import { describe, expect, it } from 'vitest';
import { buildGeometry } from '../src/core/ep/fem';
import { Substrate } from '../src/core/ep/substrate';
import { hexSheet } from '../src/core/mesh/primitives';
import { buildTissue, fiberField, PRESETS } from '../src/core/ep/tissue';
import { Region } from '../src/core/mesh/regions';
import { defaultAtrium } from './helpers';

describe('fibrosis substrate', () => {
  const sheet = hexSheet(60, 60, 0.955);
  const g = buildGeometry(sheet.positions, sheet.indices);
  const dens = (d: number) => new Float32Array(g.nV).fill(d);

  it('diffuse and patchy patterns realize the requested node fraction', () => {
    for (const pattern of ['diffuse', 'patchy'] as const) {
      for (const d of [0.1, 0.3]) {
        const s = new Substrate(g, { seed: 3, fibrosisDensity: dens(d), fibrosisPattern: pattern });
        expect(Math.abs(s.stats().fibroticNodeFraction - d), `${pattern} ${d}`).toBeLessThan(0.03);
      }
    }
  });

  it('patchy fibrosis is spatially clustered, diffuse is not', () => {
    const clustering = (pattern: 'diffuse' | 'patchy') => {
      const s = new Substrate(g, { seed: 5, fibrosisDensity: dens(0.2), fibrosisPattern: pattern });
      let both = 0, fromFib = 0;
      for (let e = 0; e < g.edgeA.length; e++) {
        const a = s.fibroticNode[g.edgeA[e]!]!, b = s.fibroticNode[g.edgeB[e]!]!;
        if (a) { fromFib++; if (b) both++; }
        if (b) { fromFib++; if (a) both++; }
      }
      return both / fromFib; // P(neighbour fibrotic | node fibrotic)
    };
    expect(clustering('patchy')).toBeGreaterThan(0.45);
    expect(clustering('diffuse')).toBeLessThan(0.3);
  });

  it('interstitial fibrosis uncouples mostly edges transverse to the fibres, nodes stay excitable', () => {
    const fib = new Float32Array(3 * g.nV);
    for (let i = 0; i < g.nV; i++) fib[3 * i] = 1; // fibres along x
    const s = new Substrate(g, { seed: 7, fibrosisDensity: dens(0.3), fibrosisPattern: 'interstitial', fiberDir: fib });
    expect(s.stats().fibroticNodeFraction).toBe(0);
    let along = 0, alongCut = 0, across = 0, acrossCut = 0;
    for (let e = 0; e < g.edgeA.length; e++) {
      const dy = Math.abs(g.positions[3 * g.edgeB[e]! + 1]! - g.positions[3 * g.edgeA[e]! + 1]!);
      if (dy < 0.1) { along++; if (s.edgeScale[e] === 0) alongCut++; } else { across++; if (s.edgeScale[e] === 0) acrossCut++; }
    }
    expect(alongCut / along).toBeLessThan(0.02);
    expect(acrossCut / across).toBeGreaterThan(0.3);
  });

  it('fibrotic nodes are electrically isolated (zero diffusivity on incident edges)', () => {
    const s = new Substrate(g, { seed: 9, fibrosisDensity: dens(0.2), fibrosisPattern: 'diffuse' });
    const D = s.edgeDiffusivity(0.5);
    for (let e = 0; e < D.length; e++) {
      if (s.fibroticNode[g.edgeA[e]!] || s.fibroticNode[g.edgeB[e]!]) expect(D[e]).toBe(0);
      else expect(D[e]).toBeCloseTo(0.5);
    }
  });

  it('the persistent preset weights fibrosis towards the posterior wall', () => {
    const { mesh } = defaultAtrium();
    const t = buildTissue(mesh, PRESETS.persistent, 1);
    const frac = (r: Region) => {
      let n = 0, f = 0;
      mesh.region.forEach((x, i) => { if (x === r) { n++; f += t.substrate.fibroticNode[i]!; } });
      return f / n;
    };
    expect(frac(Region.Posterior)).toBeGreaterThan(1.5 * frac(Region.Anterior));
    expect(t.substrate.stats().fibroticNodeFraction).toBeGreaterThan(0.12);
    expect(t.substrate.stats().fibroticNodeFraction).toBeLessThan(0.3);
  });

  it('fibre field is a unit tangent field on the atrium', () => {
    const { mesh } = defaultAtrium();
    const f = fiberField(mesh);
    for (let i = 0; i < mesh.region.length; i += 97) {
      const l = Math.hypot(f[3 * i]!, f[3 * i + 1]!, f[3 * i + 2]!);
      const dn = f[3 * i]! * mesh.normals[3 * i]! + f[3 * i + 1]! * mesh.normals[3 * i + 1]! + f[3 * i + 2]! * mesh.normals[3 * i + 2]!;
      expect(l).toBeCloseTo(1, 4);
      expect(Math.abs(dn)).toBeLessThan(1e-3);
    }
  });
});
