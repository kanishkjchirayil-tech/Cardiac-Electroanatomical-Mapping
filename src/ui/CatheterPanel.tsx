import { SPACING_OPTIONS } from '../core/catheter/roving';
import { REGIONS } from '../core/mesh/regions';
import * as C from './sim-client';
import * as S from './state';

export function CatheterPanel() {
  const cfg = S.rovingConfig.value;
  const r = S.roving.value;
  const m = S.mesh.value;
  const st = r?.stability;
  return (
    <section class="panel">
      <h2>Roving catheter</h2>
      <div class="segmented" role="radiogroup" aria-label="Catheter type">
        {([['ablation', 'Ablation (4-pole)'], ['grid', 'HD grid (16)']] as const).map(([k, label]) => (
          <button key={k} id={`cath-${k}`} role="radio" aria-checked={cfg.type === k} class={cfg.type === k ? 'on' : ''} onClick={() => C.setRovingConfig({ type: k })}>{label}</button>
        ))}
      </div>
      <p class="muted small">Click the shell to place the tip · Shift-drag to slide it · Arrow keys nudge 2 mm (Shift: 0.5 mm) · [ ] change force</p>
      <label>Contact force {cfg.force} g
        <input id="cath-force" type="range" min={0} max={60} step={1} value={cfg.force} onInput={(e) => C.setRovingConfig({ force: Number(e.currentTarget.value) })} />
      </label>
      <div class="row">
        <label>Angle {cfg.angle}°
          <input id="cath-angle" type="range" min={0} max={90} step={5} value={cfg.angle} onInput={(e) => C.setRovingConfig({ angle: Number(e.currentTarget.value) })} />
        </label>
        <label>Direction {cfg.azimuth}°
          <input id="cath-azimuth" type="range" min={0} max={350} step={10} value={cfg.azimuth} onInput={(e) => C.setRovingConfig({ azimuth: Number(e.currentTarget.value) })} />
        </label>
      </div>
      <div class="row">
        <label>Electrode spacing (mm)
          <select id="cath-spacing" value={cfg.spacing.join('-')} onChange={(e) => C.setRovingConfig({ spacing: e.currentTarget.value.split('-').map(Number) as [number, number, number] })}>
            {SPACING_OPTIONS.map((s) => <option key={s.join('-')} value={s.join('-')}>{s.join('-')}</option>)}
          </select>
        </label>
        <label class="check"><input id="cath-motion" type="checkbox" checked={S.motionEnabled.value} onChange={(e) => C.setMotion(e.currentTarget.checked)} /> Cardiac/respiratory motion</label>
      </div>
      {r && st && (
        <>
          <div class="force-readout" aria-live="polite">
            <div class="force-bar"><div style={{ width: `${Math.min(100, (r.force / 60) * 100)}%` }} class={r.force < 5 ? 'low' : r.force > 40 ? 'high' : 'ok'} /></div>
            <span class="force-num">{r.force.toFixed(0)} g</span>
            <span class={`chip ${st.stable ? 'chip-ok' : 'chip-warn'}`}>{st.stable ? 'Stable' : st.settling ? 'Settling' : 'Unstable'}</span>
          </div>
          <dl class="stats">
            <dt>Location</dt><dd>{m ? REGIONS[m.region[r.vertex]!]?.name : '—'}</dd>
            <dt>Force (last 1 s)</dt><dd>{st.forceMean.toFixed(0)} g ({st.forceMin.toFixed(0)}–{st.forceMax.toFixed(0)})</dd>
            <dt>Tip movement SD</dt><dd>{st.positionSd.toFixed(2)} mm</dd>
            <dt>Tip–tissue gap</dt><dd>{r.gap.toFixed(1)} mm</dd>
          </dl>
          <p class="muted small">Stable = movement SD &lt; 1 mm and force 5–40 g throughout the last second.</p>
        </>
      )}
    </section>
  );
}

export function SignalsPanel() {
  const s = S.signalSettings.value;
  const set = (patch: Partial<typeof s>) => C.setSignals({ ...s, ...patch });
  const noiseLevel = s.noise.noiseSd / 0.012;
  return (
    <section class="panel">
      <h2>Signals</h2>
      <div class="row">
        <label>Mains
          <select id="sig-mains" value={s.noise.lineAmp > 0 ? String(s.noise.lineFreq) : '0'}
            onChange={(e) => {
              const f = Number(e.currentTarget.value);
              set({ noise: { ...s.noise, lineFreq: f || s.noise.lineFreq, lineAmp: f ? 0.15 : 0 } });
            }}>
            <option value="50">50 Hz</option>
            <option value="60">60 Hz</option>
            <option value="0">Off</option>
          </select>
        </label>
        <label class="check"><input id="sig-notch" type="checkbox" checked={s.bipolar.notch > 0}
          onChange={(e) => {
            const n = e.currentTarget.checked ? s.noise.lineFreq : 0;
            set({ bipolar: { ...s.bipolar, notch: n }, unipolar: { ...s.unipolar, notch: n }, ecg: { ...s.ecg, notch: n } });
          }} /> Notch</label>
      </div>
      <label>Noise ×{noiseLevel.toFixed(1)}
        <input id="sig-noise" type="range" min={0} max={4} step={0.5} value={noiseLevel}
          onInput={(e) => { const k = Number(e.currentTarget.value); set({ noise: { ...s.noise, noiseSd: 0.012 * k, wanderAmp: 0.3 * Math.min(1, k) } }); }} />
      </label>
      <div class="row">
        <Band label="Bipolar" spec={s.bipolar} onChange={(b) => set({ bipolar: b })} />
        <Band label="Unipolar" spec={s.unipolar} onChange={(b) => set({ unipolar: b })} />
      </div>
    </section>
  );
}

function Band({ label, spec, onChange }: { label: string; spec: { hp: number; lp: number; notch: number }; onChange: (b: { hp: number; lp: number; notch: number }) => void }) {
  const id = label.toLowerCase();
  return (
    <fieldset class="band">
      <legend>{label} (Hz)</legend>
      <div class="band-row">
        <input id={`${id}-hp`} type="number" min={0} max={200} step={0.5} value={spec.hp} aria-label={`${label} high-pass`}
          onChange={(e) => onChange({ ...spec, hp: Math.max(0, Number(e.currentTarget.value) || 0) })} />
        <span>–</span>
        <input id={`${id}-lp`} type="number" min={10} max={999} step={10} value={spec.lp} aria-label={`${label} low-pass`}
          onChange={(e) => onChange({ ...spec, lp: Math.max(10, Number(e.currentTarget.value) || 10) })} />
      </div>
    </fieldset>
  );
}
