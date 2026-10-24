import type { PacingProtocol, PacingSite } from '../core/pacing/protocols';
import { REGIONS } from '../core/mesh/regions';
import * as C from './sim-client';
import * as S from './state';

const SITES: Array<[PacingSite, string]> = [['cs-distal', 'CS 1-2 (distal)'], ['cs-proximal', 'CS 9-10 (proximal)'], ['roving', 'Ablation tip']];
const KINDS: Array<[PacingProtocol['kind'], string]> = [['fixed', 'Fixed rate'], ['burst', 'Burst'], ['s1s2', 'S1–S2'], ['entrain', 'Entrainment']];

function defaults(kind: PacingProtocol['kind'], tcl: number): PacingProtocol {
  switch (kind) {
    case 'fixed': return { kind, cl: 600, count: Infinity };
    case 'burst': return { kind, cl: 200, count: 10 };
    case 's1s2': return { kind, s1: 600, n: 8, s2: 300 };
    case 'entrain': return { kind, cl: Math.max(150, Math.round((tcl || 300) - 20)), count: 8 };
  }
}

/** Programmed stimulation: site, output, protocol, and the signal-derived measurements. */
export function PacingPanel() {
  const req = S.pacingRequest.value;
  const st = S.pacingStatus.value;
  const last = S.lastPacing.value;
  const info = S.simInfo.value;
  const rd = info && info.backend !== 'eikonal';
  const p = req.protocol;
  const set = (patch: Partial<typeof req>) => (S.pacingRequest.value = { ...req, ...patch });
  const setP = (patch: Partial<PacingProtocol>) => set({ protocol: { ...p, ...patch } as PacingProtocol });
  const num = (label: string, key: string, value: number, min: number, max: number, step = 10) => (
    <label>{label}
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => setP({ [key]: Math.max(min, Math.min(max, Number(e.currentTarget.value) || min)) } as Partial<PacingProtocol>)} />
    </label>
  );
  const show = st ?? last;
  const roving = S.roving.value?.config.type === 'ablation';
  return (
    <section class="panel">
      <h2>Pacing</h2>
      {!rd && <p class="warn-text small">Pacing needs the reaction–diffusion engine (Simulation panel).</p>}
      <div class="row">
        <label>Site
          <select id="pace-site" value={req.site} onChange={(e) => set({ site: e.currentTarget.value as PacingSite })}>
            {SITES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>Output {req.output} mA
          <input id="pace-output" type="range" min={0.2} max={20} step={0.1} value={req.output} onInput={(e) => set({ output: Number(e.currentTarget.value) })} />
        </label>
      </div>
      <div class="segmented wrap" role="radiogroup" aria-label="Protocol">
        {KINDS.map(([k, l]) => (
          <button key={k} role="radio" aria-checked={p.kind === k} class={p.kind === k ? 'on' : ''} onClick={() => set({ protocol: defaults(k, last?.entrain?.tcl ?? NaN) })}>{l}</button>
        ))}
      </div>
      <div class="row">
        {p.kind === 's1s2' ? (
          <>
            {num('S1 (ms)', 's1', p.s1, 200, 1200)}
            {num('S1 beats', 'n', p.n, 2, 20, 1)}
            {num('S2 (ms)', 's2', p.s2, 100, 800)}
          </>
        ) : (
          <>
            {num('Cycle length (ms)', 'cl', p.cl, 100, 1500)}
            {p.kind !== 'fixed' && num('Beats', 'count', p.count, 1, 40, 1)}
          </>
        )}
      </div>
      {p.kind === 'fixed' && <p class="muted small">Continuous until stopped.</p>}
      {p.kind === 'entrain' && <p class="muted small">Pace 10–30 ms faster than the tachycardia from the ablation tip, then read PPI − TCL.</p>}
      {st ? (
        <button id="pace-toggle" class="primary danger" onClick={C.paceStop}>Stop pacing</button>
      ) : (
        <button id="pace-toggle" class="primary" disabled={!rd || (req.site === 'roving' && !roving)} onClick={() => C.pace(req)}>Start pacing</button>
      )}
      {req.site === 'roving' && !roving && <p class="muted small">Tip pacing needs the ablation catheter.</p>}
      {show && <PacingReadout st={show} />}
    </section>
  );
}

function PacingReadout({ st }: { st: NonNullable<typeof S.pacingStatus.value> }) {
  const region = REGIONS[st.rovingRegion]?.name ?? '';
  return (
    <div class="pace-readout" aria-live="polite">
      <p class="small">
        {st.active ? <span class="chip chip-warn">Pacing</span> : <span class="chip">Last manoeuvre</span>} {st.stims} stimuli · {st.output} mA
        {st.site === 'roving' && <> · tip at {region}</>}
      </p>
      <dl class="stats">
        <dt>Local capture</dt><dd>{st.localCapture === null ? '—' : st.localCapture ? 'yes' : 'no'}</dd>
        {st.csFollows !== null && <><dt>CS follows 1:1</dt><dd>{st.csFollows ? 'yes' : 'no'}</dd></>}
        {st.entrain && (
          <>
            <dt>TCL / PPI</dt><dd>{st.entrain.tcl} / {st.entrain.ppi} ms</dd>
            <dt>PPI − TCL</dt><dd class={Math.abs(st.entrain.diff) <= 30 ? 'ok-text' : ''}>{st.entrain.diff} ms {Math.abs(st.entrain.diff) <= 30 ? '(in circuit)' : '(outside)'}</dd>
          </>
        )}
      </dl>
      {st.intervals.length > 0 && (
        <table class="pace-table">
          <thead><tr><th>Bipole</th><th>Stim → EGM</th><th>Dist</th></tr></thead>
          <tbody>
            {st.intervals.map((iv) => (
              <tr key={iv.channel}><td>{iv.channel}</td><td>{iv.ms === null ? '—' : `${iv.ms} ms`}</td><td>{Number.isFinite(iv.distance) ? `${iv.distance.toFixed(0)} mm` : ''}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
