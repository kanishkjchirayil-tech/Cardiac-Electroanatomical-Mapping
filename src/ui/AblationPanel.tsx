import { interLesionDistances, NEW_SET_DISTANCE } from '../core/ablation/lesion';
import { RF_CONSTANTS } from '../core/ablation/rf';
import { lesionTagColor } from '../render/colormaps';
import { REGIONS } from '../core/mesh/regions';
import * as C from './sim-client';
import * as S from './state';

const LQI_TARGET = 10;
const css = (c: [number, number, number]) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;

export function AblationPanel() {
  const a = S.ablationSettings.value;
  const r = S.roving.value;
  const rf = S.rf.value;
  const m = S.mesh.value;
  const all = S.lesions.value;
  const lesions = all.filter((l) => !l.prior);
  const prior = all.length - lesions.length;
  const isAblation = r?.config.type === 'ablation';
  const zone = S.esophagealZone.value;
  const overEsophagus = !!(r && zone && zone[r.vertex]);
  const dist = interLesionDistances(lesions);
  const gaps = dist.filter((d) => d > a.gapThreshold && d <= NEW_SET_DISTANCE).length;
  const hot = rf && rf.esophagealTemp >= RF_CONSTANTS.tempWarning;
  return (
    <section class="panel">
      <h2>Ablation</h2>
      <div class="row">
        <label>Power {a.power} W
          <input id="rf-power" type="range" min={10} max={50} step={1} value={a.power} onInput={(e) => C.setAblationSettings({ power: Number(e.currentTarget.value) })} />
        </label>
        <label>Duration {a.duration} s
          <input id="rf-duration" type="range" min={3} max={60} step={1} value={a.duration} onInput={(e) => C.setAblationSettings({ duration: Number(e.currentTarget.value) })} />
        </label>
      </div>
      <p class="muted small">Contact force is set in the catheter panel ({S.rovingConfig.value.force} g).</p>
      <div class="row">
        <label>RF clock
          <select id="rf-clock" value={String(a.timeScale)} onChange={(e) => C.setAblationSettings({ timeScale: Number(e.currentTarget.value) })}
            title="RF seconds per simulated second. Real RF is slow to watch, so the RF clock is accelerated.">
            {[1, 5, 10, 20].map((k) => <option key={k} value={k}>{k}× sim time</option>)}
          </select>
        </label>
        <label class="check"><input id="rf-instant" type="checkbox" checked={S.rfInstant.value} onChange={(e) => (S.rfInstant.value = e.currentTarget.checked)} /> Instant</label>
      </div>
      <div class="row">
        <label class="check"><input id="rf-edema" type="checkbox" checked={a.edema} onChange={(e) => C.setAblationSettings({ edema: e.currentTarget.checked })} /> Edema</label>
        <label>Recovery (sim s)
          <input id="rf-edema-sec" type="number" min={2} max={600} step={1} value={a.edemaRecoverySec} disabled={!a.edema}
            onChange={(e) => C.setAblationSettings({ edemaRecoverySec: Math.max(2, Number(e.currentTarget.value) || 30) })} />
        </label>
      </div>
      {overEsophagus && <p class="warn-text small">Tip is on the posterior wall over the esophagus: lower power and duration.</p>}
      {rf ? (
        <button id="rf-toggle" class="primary danger" onClick={C.rfStop}>RF OFF</button>
      ) : (
        <button id="rf-toggle" class="primary" disabled={!isAblation} onClick={C.rfStart}
          title={isAblation ? 'Deliver RF at the catheter tip' : 'Select the ablation catheter to deliver RF'}>RF ON</button>
      )}
      {!isAblation && <p class="muted small">RF needs the ablation catheter (catheter panel).</p>}
      {isAblation && !rf && !S.rfInstant.value && !S.simRunning.value && <p class="muted small">RF advances while the simulation runs (or tick Instant).</p>}
      {rf && (
        <div class={`rf-live${hot ? ' alarm' : ''}`} aria-live="polite">
          <div class="rf-progress"><div style={{ width: `${Math.min(100, (100 * rf.elapsed) / a.duration)}%` }} /></div>
          <dl class="stats">
            <dt>Time</dt><dd>{rf.elapsed.toFixed(1)} / {a.duration} s</dd>
            <dt>Power · force</dt><dd>{rf.power} W · {rf.force.toFixed(0)} g</dd>
            <dt>Impedance</dt><dd>{rf.impedance.toFixed(0)} Ω (−{rf.impedanceDrop.toFixed(1)})</dd>
            <dt>Force–time integral</dt><dd>{rf.fti.toFixed(0)} g·s</dd>
            <dt>Effective energy</dt><dd>{rf.energy.toFixed(0)} J</dd>
            <dt>Predicted depth / wall</dt><dd>{rf.depth.toFixed(1)} / {rf.thickness.toFixed(1)} mm</dd>
            <dt>Lesion quality index</dt><dd style={{ color: css(lesionTagColor(rf.lqi)) }}>{rf.lqi.toFixed(1)} (target {LQI_TARGET})</dd>
            {rf.inEsophagealZone && <><dt>Esophageal temp</dt><dd class={hot ? 'warn-text' : ''}>{rf.esophagealTemp.toFixed(1)} °C</dd></>}
          </dl>
          {hot && <p class="warn-text small" role="alert">Esophageal temperature ≥ {RF_CONSTANTS.tempWarning} °C: stop RF.</p>}
        </div>
      )}
      <div class="row wrap-row">
        <label class="check"><input type="checkbox" checked={S.showLesionTags.value} onChange={(e) => (S.showLesionTags.value = e.currentTarget.checked)} /> Lesion tags</label>
        <label class="check"><input type="checkbox" checked={S.showEsophagus.value} onChange={(e) => (S.showEsophagus.value = e.currentTarget.checked)} /> Esophagus</label>
      </div>
      <div class="row">
        <label>Gap warning above (mm)
          <input id="rf-gap" type="number" min={2} max={15} step={0.5} value={a.gapThreshold}
            onChange={(e) => C.setAblationSettings({ gapThreshold: Math.max(2, Number(e.currentTarget.value) || 6) })} />
        </label>
      </div>
      <p class="muted small">
        {lesions.length} lesion{lesions.length === 1 ? '' : 's'}{prior ? ` (+${prior} from the previous procedure, grey tags)` : ''}
        {gaps > 0 ? <span class="warn-text"> · {gaps} gap{gaps === 1 ? '' : 's'} &gt; {a.gapThreshold} mm</span> : null}
      </p>
      {lesions.length > 0 && (
        <div class="point-list" role="list" aria-label="Lesions">
          <table>
            <thead><tr><th>#</th><th>LQI</th><th>Depth/wall</th><th>W·s</th><th>FTI</th><th>Δ prev</th><th>Site</th></tr></thead>
            <tbody>
              {[...lesions].reverse().map((l) => {
                const i = lesions.indexOf(l);
                const d = dist[i]!;
                const gap = d > a.gapThreshold && d <= NEW_SET_DISTANCE;
                return (
                  <tr key={l.id} class={l.active ? 'sel' : ''}>
                    <td><span class="swatch" style={{ background: css(lesionTagColor(l.lqi)) }} /> {l.id}</td>
                    <td>{l.lqi.toFixed(1)}</td>
                    <td>{l.depth.toFixed(1)}/{l.thickness.toFixed(1)}</td>
                    <td>{l.power}·{l.duration.toFixed(0)}</td>
                    <td>{l.fti.toFixed(0)}</td>
                    <td class={gap ? 'warn-text' : ''}>{Number.isFinite(d) ? `${d.toFixed(1)}${gap ? ' ⚠' : ''}` : '—'}</td>
                    <td>{m ? REGIONS[m.region[l.vertex]!]?.key : ''}{Number.isFinite(l.esophagealTemp) && l.esophagealTemp >= RF_CONSTANTS.tempWarning ? ' · hot' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div class="point-actions">
        <button id="rf-reset" disabled={!lesions.length} onClick={() => { if (confirm('Remove your lesions and restore the tissue?')) C.resetLesions(); }}>Reset lesions</button>
      </div>
      <p class="muted small">LQI = 10 × predicted depth / local wall thickness (10 ⇔ transmural). Tags: green ≥ 10, amber 8–10, red &lt; 8. Δ prev = distance to the previous lesion; jumps &gt; {NEW_SET_DISTANCE} mm start a new set.</p>
    </section>
  );
}
