import * as C from './sim-client';
import * as S from './state';

/** Autonomic tone sliders (phenomenological model, MODEL.md §7.1). */
export function AutonomicPanel() {
  const a = S.autonomic.value;
  const st = S.autonomicState.value;
  const rd = S.simInfo.value && S.simInfo.value.backend !== 'eikonal';
  return (
    <section class="panel">
      <h2>Autonomic tone</h2>
      <p class="muted small">Phenomenological model: tone scales refractoriness, sinus rate and PV ectopy by simple documented rules, not by simulated neurotransmitters.</p>
      <label>Vagal {Math.round(100 * a.vagal)} %
        <input id="auto-vagal" type="range" min={0} max={1} step={0.05} value={a.vagal} onInput={(e) => C.setAutonomic({ vagal: Number(e.currentTarget.value) })} />
      </label>
      <label>Sympathetic {Math.round(100 * a.sympathetic)} %
        <input id="auto-symp" type="range" min={0} max={1} step={0.05} value={a.sympathetic} onInput={(e) => C.setAutonomic({ sympathetic: Number(e.currentTarget.value) })} />
      </label>
      <label class="check"><input id="auto-hetero" type="checkbox" checked={a.heterogeneous} onChange={(e) => C.setAutonomic({ heterogeneous: e.currentTarget.checked })} /> Uneven vagal effect, concentrated in GP zones near the PV antra</label>
      <dl class="stats">
        <dt>Effective sinus CL</dt><dd>{st ? (st.sinusCl > 0 ? `${st.sinusCl} ms` : 'off') : '—'}</dd>
      </dl>
      <ul class="muted small autonomic-notes">
        <li>Vagal: shorter APD/ERP (up to ≈ 50 % in GP zones) and slower sinus rate.</li>
        <li>Sympathetic: faster sinus rate, more frequent and more likely PV-sleeve ectopy{rd ? '' : ' (needs reaction–diffusion)'}.</li>
        <li>Ablating inside a GP zone reduces its vagal effect (teacher view: GP zones).</li>
      </ul>
    </section>
  );
}
