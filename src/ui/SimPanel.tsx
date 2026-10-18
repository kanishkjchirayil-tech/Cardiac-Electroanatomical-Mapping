import { useState } from 'preact/hooks';
import { PRESETS, type PresetId } from '../core/ep/tissue';
import type { IonicModelId } from '../core/ep/ionic';
import type { FibrosisPattern } from '../core/ep/substrate';
import type { RestitutionPoint } from '../core/ep/calibrate';
import * as C from './sim-client';
import * as S from './state';

const SPEEDS: Array<[number, string]> = [[0.1, '0.1×'], [0.25, '0.25×'], [0.5, '0.5×'], [1, '1×'], [0, 'Max']];

export function SimPanel() {
  const cfg = S.simConfig.value;
  const info = S.simInfo.value;
  const busy = !info;
  return (
    <section class="panel">
      <h2>Simulation</h2>
      <div class="segmented" role="radiogroup" aria-label="Solver mode">
        {(['eikonal', 'rd'] as const).map((m) => (
          <button key={m} id={`mode-${m}`} role="radio" aria-checked={cfg.mode === m} class={cfg.mode === m ? 'on' : ''} onClick={() => C.configure({ mode: m })}>
            {m === 'eikonal' ? 'Eikonal (fast)' : 'Reaction–diffusion'}
          </button>
        ))}
      </div>
      <label>Tissue
        <select id="sim-preset" value={cfg.preset} onChange={(e) => C.configure({ preset: e.currentTarget.value as PresetId })}>
          {Object.values(PRESETS).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <p class="muted small">{PRESETS[cfg.preset].description}</p>
      <div class="row">
        <label>Ionic model
          <select id="sim-ionic" value={cfg.ionic} onChange={(e) => C.configure({ ionic: e.currentTarget.value as IonicModelId })}>
            <option value="ms">Mitchell–Schaeffer</option>
            <option value="ap">Aliev–Panfilov</option>
            <option value="fk">Fenton–Karma</option>
          </select>
        </label>
        <label>Sinus CL (ms)
          <input id="sim-cl" type="number" min={0} max={2000} step={50} value={cfg.sinusCl}
            onChange={(e) => C.configure({ sinusCl: Math.max(0, Math.min(2000, Number(e.currentTarget.value) || 0)) })} />
        </label>
      </div>
      <div class="row">
        <label>Fibrosis ×{cfg.fibrosisScale.toFixed(1)}
          <input id="sim-fib" type="range" min={0} max={2} step={0.1} value={cfg.fibrosisScale}
            onChange={(e) => C.configure({ fibrosisScale: Number(e.currentTarget.value) })} />
        </label>
        <label>Pattern
          <select id="sim-pattern" value={cfg.fibrosisPattern} onChange={(e) => C.configure({ fibrosisPattern: e.currentTarget.value as FibrosisPattern })}>
            <option value="patchy">Patchy</option>
            <option value="diffuse">Diffuse</option>
            <option value="interstitial">Interstitial</option>
          </select>
        </label>
      </div>

      <div class="transport" role="toolbar" aria-label="Simulation clock">
        {S.simRunning.value
          ? <button id="sim-pause" class="primary" onClick={C.pause}>Pause</button>
          : <button id="sim-play" class="primary" disabled={busy} onClick={C.play}>Run</button>}
        <button id="sim-step" disabled={busy || S.simRunning.value} onClick={() => C.step(10)} title="Advance 10 ms of simulated time">+10 ms</button>
        <button id="sim-reset" disabled={busy} onClick={C.reset}>Reset</button>
      </div>
      <div class="segmented speeds" role="radiogroup" aria-label="Speed">
        {SPEEDS.map(([v, label]) => (
          <button key={label} role="radio" aria-checked={S.speedTarget.value === v} class={S.speedTarget.value === v ? 'on' : ''} onClick={() => C.setSpeed(v)}>{label}</button>
        ))}
      </div>
      <div class="clock">
        <span>t = {(S.simTime.value / 1000).toFixed(3)} s</span>
        <span>{S.simSpeed.value > 0 ? `${S.simSpeed.value < 0.1 ? S.simSpeed.value.toFixed(3) : S.simSpeed.value.toFixed(2)}× real time` : '—'}</span>
      </div>
      {S.simStatus.value && <p class="muted small">{S.simStatus.value}</p>}
      {info && (
        <dl class="stats">
          <dt>Engine</dt><dd>{info.backend === 'eikonal' ? 'Eikonal (fast marching)' : info.backend === 'webgpu' ? 'WebGPU' : 'CPU worker'}</dd>
          <dt>Healthy CV</dt><dd>{info.cv.toFixed(2)} m/s</dd>
          <dt>APD90</dt><dd>{info.apd90.toFixed(0)} ms</dd>
          <dt>D₀</dt><dd>{info.D0.toFixed(3)} mm²/ms</dd>
          <dt>Time step</dt><dd>{info.dt} ms{info.diffusionSubsteps > 1 ? ` (${info.diffusionSubsteps} diffusion substeps)` : ''}</dd>
          <dt>Fibrotic nodes</dt><dd>{(100 * info.fibroticFraction).toFixed(1)} %</dd>
          {info.removedEdgeFraction > 0 && <><dt>Uncoupled edges</dt><dd>{(100 * info.removedEdgeFraction).toFixed(1)} %</dd></>}
          {info.eikonalMs !== null && <><dt>Eikonal map</dt><dd>{info.eikonalMs.toFixed(0)} ms</dd></>}
        </dl>
      )}
      {info?.gpuError && <p class="warnings small">WebGPU unavailable ({info.gpuError}); using the CPU worker.</p>}
      <p class="small"><a class="link" href="./selftest.html" target="_blank" rel="noopener">Solver self-test and speed check ↗</a></p>
      <TeacherControls />
      <TissueLab />
    </section>
  );
}

function TeacherControls() {
  const on = S.teacherView.value;
  const opts: Array<[S.TeacherOverlay, string]> = [['vm', 'Voltage'], ['lat', 'True activation'], ['substrate', 'Substrate']];
  return (
    <div class="teacher">
      <label class="check">
        <input id="teacher-view" type="checkbox" checked={on} onChange={(e) => {
          S.teacherView.value = e.currentTarget.checked;
          if (e.currentTarget.checked && S.teacherOverlay.peek() !== 'vm') C.requestActivation();
        }} />
        Teacher view (shows hidden ground truth)
      </label>
      {on && (
        <div class="segmented" role="radiogroup" aria-label="Teacher overlay">
          {opts.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={S.teacherOverlay.value === k} class={S.teacherOverlay.value === k ? 'on' : ''}
              onClick={() => { S.teacherOverlay.value = k; if (k !== 'vm') C.requestActivation(); }}>{label}</button>
          ))}
        </div>
      )}
      {on && S.teacherOverlay.value === 'lat' && (
        <button class="small-btn" onClick={C.requestActivation}>Refresh activation map</button>
      )}
      {!on && <p class="muted small">Off by default: in a real study the tissue state is unknown until you map it.</p>}
    </div>
  );
}

function TissueLab() {
  const r = S.labResult.value;
  return (
    <div class="lab">
      <button id="run-lab" disabled={S.labRunning.value || !S.simInfo.value} onClick={C.runLab}>
        {S.labRunning.value ? 'Measuring…' : 'Tissue lab: measure CV, APD, restitution'}
      </button>
      {r && (
        <div class="lab-result">
          <p class="small">{r.label}: plane-wave CV {r.cv.toFixed(2)} m/s, APD90 {r.apd90.toFixed(0)} ms, ERP {Number.isFinite(r.restitution.erp) ? `${r.restitution.erp} ms` : 'not reached'} (S1 {r.restitution.s1} ms, 1D strip)</p>
          <RestitutionChart title="APD restitution" unit="APD90 (ms)" points={r.restitution.points} y={(p) => p.apd90} />
          <RestitutionChart title="CV restitution" unit="CV (m/s)" points={r.restitution.points} y={(p) => p.cv} digits={2} />
        </div>
      )}
    </div>
  );
}

/** Small single-series line chart (diastolic interval on x) with per-point hover readout. */
function RestitutionChart({ title, unit, points, y, digits = 0 }: { title: string; unit: string; points: RestitutionPoint[]; y: (p: RestitutionPoint) => number; digits?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = [...points].filter((p) => Number.isFinite(y(p)) && Number.isFinite(p.di)).sort((a, b) => a.di - b.di);
  if (pts.length < 2) return <p class="muted small">{title}: not enough points.</p>;
  const W = 260, H = 130, L = 40, R = 10, T = 10, B = 28;
  const xMax = Math.max(...pts.map((p) => p.di));
  const ys = pts.map(y);
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const xt = niceTicks(0, xMax, 5);
  const y0 = yt[0]!, y1 = yt[yt.length - 1]!, x1 = xt[xt.length - 1]!;
  const sx = (x: number) => L + (x / x1) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.di).toFixed(1)},${sy(y(p)).toFixed(1)}`).join('');
  const h = hover !== null ? pts[hover] : null;
  return (
    <figure class="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${unit} versus diastolic interval`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          pts.forEach((p, i) => { if (Math.abs(sx(p.di) - x) < Math.abs(sx(pts[best]!.di) - x)) best = i; });
          setHover(best);
        }}>
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} class="grid" />
            <text x={L - 4} y={sy(v) + 3} class="tick" text-anchor="end">{v.toFixed(digits)}</text>
          </g>
        ))}
        {xt.map((v) => (
          <text key={`x${v}`} x={sx(v)} y={H - B + 13} class="tick" text-anchor="middle">{v}</text>
        ))}
        <text x={(L + W - R) / 2} y={H - 3} class="axis-label" text-anchor="middle">Diastolic interval (ms)</text>
        <path d={path} class="series" />
        {pts.map((p, i) => <circle key={i} cx={sx(p.di)} cy={sy(y(p))} r={hover === i ? 4.5 : 3} class="dot" />)}
        {h && <line x1={sx(h.di)} x2={sx(h.di)} y1={T} y2={H - B} class="crosshair" />}
      </svg>
      <div class="chart-readout small">{h ? `DI ${h.di.toFixed(0)} ms (S2 coupling ${h.ci} ms) → ${unit.split(' (')[0]} ${y(h).toFixed(digits)} ${unit.match(/\((.*)\)/)?.[1] ?? ''}` : unit}</div>
    </figure>
  );
}

/** Round tick values (1, 2, 5 × 10^k steps) spanning [lo, hi]. */
function niceTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}
