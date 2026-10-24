import { DEFAULT_NOISE, ElectrodeNoise, type NoiseSpec } from './noise';
import { BIPOLAR_BAND, ECG_BAND, FilterChain, UNIPOLAR_BAND, type BandSpec } from './filters';

/**
 * Recording system: turns raw unipolar electrode potentials (from lead fields) into displayed
 * channels the way an EP recording system does (MODEL.md §3.3):
 *   raw potential + artifacts  →  referencing (bipolar difference, or unipolar vs. Wilson terminal)
 *   →  causal band-pass (+ optional notch) per channel.
 */
export type ChannelKind = 'ecg' | 'bipolar' | 'unipolar';
export type ElectrodeGroup = 'ecg' | 'cs' | 'map' | 'grid';

export interface ElectrodeDef {
  name: string;
  group: ElectrodeGroup;
}

export interface ChannelDef {
  name: string;
  kind: ChannelKind;
  group: ElectrodeGroup;
  /** Shown in the EGM panel (others are mapping-only channels). */
  display: boolean;
  /** Mapping catheter the channel belongs to, if any. */
  catheter?: 'ablation' | 'grid';
  /** Electrode index (positive input). */
  plus: number;
  /** Electrode index of the negative input, or −1 for the Wilson central terminal. */
  minus: number;
}

export interface SignalSettings {
  noise: NoiseSpec;
  bipolar: BandSpec;
  unipolar: BandSpec;
  ecg: BandSpec;
}

export const DEFAULT_SIGNALS: SignalSettings = { noise: DEFAULT_NOISE, bipolar: BIPOLAR_BAND, unipolar: UNIPOLAR_BAND, ecg: ECG_BAND };

export class RecordingSystem {
  private noise: ElectrodeNoise[];
  private filters: FilterChain[];
  /** Indices of the electrodes forming the Wilson central terminal. */
  readonly wct: number[];

  constructor(readonly electrodes: ElectrodeDef[], readonly channels: ChannelDef[], readonly fs: number, settings: SignalSettings, seed: number) {
    this.wct = ['RA', 'LA', 'LL'].map((n) => electrodes.findIndex((e) => e.name === n)).filter((i) => i >= 0);
    this.noise = [];
    this.filters = [];
    this.configure(settings, seed);
  }

  configure(settings: SignalSettings, seed: number): void {
    // Body-surface electrodes pick up far less intracardiac-style noise.
    this.noise = this.electrodes.map((e, i) => {
      const scale = e.group === 'ecg' ? 0.1 : 1;
      const s = settings.noise;
      return new ElectrodeNoise({ ...s, lineAmp: s.lineAmp * scale, wanderAmp: s.wanderAmp * scale, noiseSd: s.noiseSd * scale }, seed * 131 + i);
    });
    this.filters = this.channels.map((c) => new FilterChain(c.kind === 'ecg' ? settings.ecg : c.kind === 'bipolar' ? settings.bipolar : settings.unipolar, this.fs));
  }

  /**
   * Process `n` samples starting at time t0 (ms). raw is n × electrodes (row-major).
   * Returns n × channels (row-major), and fills `rawOut` (if given) with unfiltered channel values.
   */
  process(t0: number, raw: Float32Array, n: number, rawOut?: Float32Array): Float32Array {
    const nE = this.electrodes.length, nC = this.channels.length;
    const out = new Float32Array(n * nC);
    const e = new Float64Array(nE);
    const dt = 1000 / this.fs;
    for (let s = 0; s < n; s++) {
      const t = t0 + s * dt;
      for (let k = 0; k < nE; k++) e[k] = raw[s * nE + k]! + this.noise[k]!.sample(t);
      let wct = 0;
      for (const k of this.wct) wct += e[k]! / this.wct.length;
      for (let c = 0; c < nC; c++) {
        const ch = this.channels[c]!;
        const v = e[ch.plus]! - (ch.minus >= 0 ? e[ch.minus]! : wct);
        if (rawOut) rawOut[s * nC + c] = v;
        out[s * nC + c] = this.filters[c]!.process(v);
      }
    }
    return out;
  }
}

/**
 * Standard layout. Displayed: ECG I, II, V1; CS 9-10 … CS 1-2; ablation MAP 1-2, MAP 3-4, MAP 1 and
 * MAP 2 unipolar; grid G1-2, G5-6, G9-10, G13-14 and G1 unipolar. Mapping-only: unipolar and
 * row-bipolar channels for all 16 grid electrodes.
 */
export function standardLayout(): { electrodes: ElectrodeDef[]; channels: ChannelDef[] } {
  const electrodes: ElectrodeDef[] = [
    { name: 'RA', group: 'ecg' }, { name: 'LA', group: 'ecg' }, { name: 'LL', group: 'ecg' }, { name: 'V1', group: 'ecg' },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `CS ${i + 1}`, group: 'cs' as const })),
    ...Array.from({ length: 4 }, (_, i) => ({ name: `MAP ${i + 1}`, group: 'map' as const })),
    ...Array.from({ length: 16 }, (_, i) => ({ name: `G${i + 1}`, group: 'grid' as const })),
  ];
  const idx = (n: string) => electrodes.findIndex((e) => e.name === n);
  const channels: ChannelDef[] = [
    { name: 'I', kind: 'ecg', group: 'ecg', display: true, plus: idx('LA'), minus: idx('RA') },
    { name: 'II', kind: 'ecg', group: 'ecg', display: true, plus: idx('LL'), minus: idx('RA') },
    { name: 'V1', kind: 'ecg', group: 'ecg', display: true, plus: idx('V1'), minus: -1 },
  ];
  for (let p = 9; p >= 1; p -= 2) channels.push({ name: `CS ${p}-${p + 1}`, kind: 'bipolar', group: 'cs', display: true, plus: idx(`CS ${p}`), minus: idx(`CS ${p + 1}`) });
  const abl = { catheter: 'ablation' as const, group: 'map' as const, display: true };
  channels.push(
    { name: 'MAP 1-2', kind: 'bipolar', ...abl, plus: idx('MAP 1'), minus: idx('MAP 2') },
    { name: 'MAP 3-4', kind: 'bipolar', ...abl, plus: idx('MAP 3'), minus: idx('MAP 4') },
    { name: 'MAP 1 uni', kind: 'unipolar', ...abl, plus: idx('MAP 1'), minus: -1 },
    { name: 'MAP 2 uni', kind: 'unipolar', ...abl, plus: idx('MAP 2'), minus: -1 },
  );
  for (let k = 1; k <= 16; k++) {
    const partner = k % 4 === 0 ? k - 1 : k + 1;
    channels.push({ name: `G${k}-${partner}`, kind: 'bipolar', group: 'grid', catheter: 'grid', display: (k - 1) % 4 === 0, plus: idx(`G${k}`), minus: idx(`G${partner}`) });
  }
  for (let k = 1; k <= 16; k++) channels.push({ name: `G${k} uni`, kind: 'unipolar', group: 'grid', catheter: 'grid', display: k === 1, plus: idx(`G${k}`), minus: -1 });
  return { electrodes, channels };
}
