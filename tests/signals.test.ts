import { describe, expect, it } from 'vitest';
import { buildLeadField, buildSourceGeometry, applyLeadField } from '../src/core/signals/leadfield';
import { FilterChain, BIPOLAR_BAND, UNIPOLAR_BAND } from '../src/core/signals/filters';
import { ElectrodeNoise, DEFAULT_NOISE } from '../src/core/signals/noise';
import { RecordingSystem, standardLayout, DEFAULT_SIGNALS } from '../src/core/signals/recording';
import { detectActivations, cycleLength } from '../src/core/signals/detect';
import { buildCsCatheter, CS_SPACING } from '../src/core/catheter/cs';
import { contactGap, rovingPose, DEFAULT_ROVING, TipMotion, isStable } from '../src/core/catheter/roving';
import { hexSheet } from '../src/core/mesh/primitives';
import { getV, dist, dot, sub } from '../src/core/math/vec3';
import { Rng } from '../src/core/rng';
import { defaultAtrium } from './helpers';

describe('lead fields (dipole-source volume conductor)', () => {
  it('equal a direct per-triangle dipole sum for arbitrary potentials', () => {
    const s = hexSheet(20, 20, 1);
    const n = s.positions.length / 3;
    const thickness = new Float32Array(n).fill(2);
    const src = buildSourceGeometry(s.positions, s.indices, { thickness });
    const rng = new Rng(3);
    const v = Float32Array.from({ length: n }, () => rng.next());
    const x: [number, number, number] = [9.3, 11.1, -1.5]; // below the sheet (normal is +z)
    const lf = buildLeadField(src, x, { K: 0.02, cutoff: Infinity });
    // Independent evaluation: in-plane least-squares gradient per triangle.
    let direct = 0;
    const P = s.positions, I = s.indices;
    for (let f = 0; f < I.length / 3; f++) {
      const [a, b, c] = [I[3 * f]!, I[3 * f + 1]!, I[3 * f + 2]!];
      const pa = getV(P, a), pb = getV(P, b), pc = getV(P, c);
      // Flat sheet in z = 0: solve 2×2 for ∇v.
      const e1 = sub(pb, pa), e2 = sub(pc, pa);
      const det = e1[0] * e2[1] - e1[1] * e2[0];
      const d1 = v[b]! - v[a]!, d2 = v[c]! - v[a]!;
      const gx = (d1 * e2[1] - d2 * e1[1]) / det, gy = (e1[0] * d2 - e2[0] * d1) / det;
      const area = Math.abs(det) / 2;
      const cen: [number, number, number] = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, 1 * Math.sign(det)];
      const r = sub(x, cen);
      const r3 = Math.hypot(...r) ** 3;
      direct += (-0.02 * area * 2 * 100 * (gx * r[0] + gy * r[1])) / r3;
    }
    expect(applyLeadField(lf, v)).toBeCloseTo(direct, 6);
  });

  it('a wavefront approaching the electrode gives a positive potential, a receding one negative', () => {
    const s = hexSheet(40, 10, 1);
    const n = s.positions.length / 3;
    const src = buildSourceGeometry(s.positions, s.indices, { thickness: new Float32Array(n).fill(2) });
    const lf = buildLeadField(src, [20, 5, -1.5], { K: 0.02, cutoff: Infinity });
    const front = (xf: number) => Float32Array.from({ length: n }, (_, i) => (s.positions[3 * i]! < xf ? 1 : 0)); // depolarized behind, moving +x
    expect(applyLeadField(lf, front(12))).toBeGreaterThan(0);
    expect(applyLeadField(lf, front(28))).toBeLessThan(0);
  });

  it('inexcitable tissue generates no source', () => {
    const s = hexSheet(10, 10, 1);
    const n = s.positions.length / 3;
    const src = buildSourceGeometry(s.positions, s.indices, { thickness: new Float32Array(n).fill(2), excitable: new Uint8Array(n) });
    expect(src.volume.every((x) => x === 0)).toBe(true);
  });
});

describe('filters and artifacts', () => {
  it('bipolar 30–500 Hz and unipolar 1–240 Hz band-pass responses', () => {
    const bip = new FilterChain(BIPOLAR_BAND, 2000), uni = new FilterChain(UNIPOLAR_BAND, 2000);
    expect(bip.gain(150)).toBeGreaterThan(0.9);
    expect(bip.gain(5)).toBeLessThan(0.01);
    expect(Math.abs(bip.gain(30) - 0.5)).toBeLessThan(0.05); // −6 dB corner for two cascaded Butterworth biquads
    expect(uni.gain(20)).toBeGreaterThan(0.95);
    expect(uni.gain(0.1)).toBeLessThan(0.02);
    expect(uni.gain(700)).toBeLessThan(0.1);
    const notch = new FilterChain({ ...BIPOLAR_BAND, notch: 50 }, 2000);
    expect(notch.gain(50)).toBeLessThan(0.05);
  });

  it('AR(2) colored noise has the requested standard deviation', () => {
    const e = new ElectrodeNoise({ ...DEFAULT_NOISE, lineAmp: 0, wanderAmp: 0, noiseSd: 0.02 }, 1);
    let s2 = 0;
    const N = 200000;
    for (let i = 0; i < N; i++) s2 += e.sample(i * 0.5) ** 2;
    expect(Math.sqrt(s2 / N)).toBeGreaterThan(0.017);
    expect(Math.sqrt(s2 / N)).toBeLessThan(0.023);
  });

  it('bipolar referencing rejects common-mode mains interference', () => {
    const { electrodes, channels } = standardLayout();
    const rec = new RecordingSystem(electrodes, channels, 2000, { ...DEFAULT_SIGNALS, noise: { ...DEFAULT_NOISE, noiseSd: 0, wanderAmp: 0 } }, 1);
    const N = 4000;
    const out = rec.process(0, new Float32Array(N * electrodes.length), N);
    const rms = (name: string) => {
      const c = channels.findIndex((x) => x.name === name);
      let s = 0;
      for (let i = 1000; i < N; i++) s += out[i * channels.length + c]! ** 2;
      return Math.sqrt(s / (N - 1000));
    };
    expect(rms('MAP 1-2')).toBeLessThan(0.15 * rms('MAP 1 uni'));
    expect(rms('MAP 1 uni')).toBeGreaterThan(0.05);
  });

  it('activation detector recovers the cycle length of a spike train', () => {
    const fs = 2000, x = new Float32Array(fs * 4);
    for (let k = 0; k < 6; k++) {
      const i0 = Math.round((0.1 + k * 0.65) * fs);
      for (let j = 0; j < 20; j++) x[i0 + j] = Math.sin((Math.PI * j) / 10) * (j < 10 ? 1 : -0.6);
    }
    expect(cycleLength(detectActivations(x, fs), fs)).toBeCloseTo(650, 0);
  });
});

describe('catheters', () => {
  const { mesh } = defaultAtrium();

  it('CS decapolar: 2-8-2 spacing, proximal septal → distal lateral, epicardial along the posterior-inferior annulus', () => {
    const cs = buildCsCatheter(mesh);
    expect(cs.electrodes.length).toBe(10);
    // electrodes[0] = CS 1 (distal) … [9] = CS 10 (proximal).
    for (let i = 0; i < 9; i++) {
      const d = dist(cs.electrodes[9 - i]!, cs.electrodes[8 - i]!);
      expect(Math.abs(d - CS_SPACING[i]!)).toBeLessThan(0.25 * CS_SPACING[i]! + 0.3);
    }
    expect(cs.electrodes[9]![0]).toBeLessThan(cs.electrodes[0]![0]); // proximal is to the patient's right (septal)
    const mv = mesh.anatomy!.mitral;
    for (const e of cs.electrodes) {
      // Outside the wall: beyond the epicardium of the nearest vertex.
      let best = 0, bd = Infinity;
      for (let i = 0; i < mesh.region.length; i++) { const d = dist(getV(mesh.positions, i), e); if (d < bd) { bd = d; best = i; } }
      expect(dot(sub(e, getV(mesh.positions, best)), getV(mesh.normals, best))).toBeGreaterThan(mesh.wallThickness[best]!);
      expect(dist(e, mv.center)).toBeLessThan(mv.radius + 15);
      expect(e[2]).toBeLessThan(mv.center[2] + 5); // inferior half of the annulus
    }
  });

  it('roving catheter: firmer contact brings the tip closer; electrodes lie along the catheter axis', () => {
    expect(contactGap(0)).toBeCloseTo(3, 5);
    expect(contactGap(20)).toBeLessThan(0.05);
    const v = 1234;
    const p = rovingPose(getV(mesh.positions, v), getV(mesh.normals, v), { ...DEFAULT_ROVING, angle: 0 });
    for (let k = 1; k < 4; k++) {
      const d = sub(p.electrodes[k]!, p.electrodes[0]!);
      expect(dot(d, p.axis)).toBeCloseTo(Math.hypot(...d), 5);
    }
    expect(dot(p.axis, getV(mesh.normals, v))).toBeCloseTo(-1, 5); // perpendicular: pointing into the blood pool
  });

  it('tip motion: firm contact is stable, floating catheter is not', () => {
    const firm = new TipMotion(1, [0, 0, 1]), loose = new TipMotion(1, [0, 0, 1]);
    for (let t = 0; t <= 3000; t += 20) { firm.update(t, 20, 800); loose.update(t, 2, 800); }
    expect(isStable(firm.stability())).toBe(true);
    expect(isStable(loose.stability())).toBe(false);
    expect(loose.stability().positionSd).toBeGreaterThan(2 * firm.stability().positionSd);
  });
});
