import { useEffect, useRef } from 'preact/hooks';
import { REGIONS } from '../core/mesh/regions';
import type { MapPoint } from '../core/mapping/types';
import * as M from './mapping-state';
import * as S from './state';

const MAP_TYPES: Array<[M.MapType, string]> = [
  ['lat', 'LAT'],
  ['bipolar', 'Bipolar V'],
  ['unipolar', 'Unipolar V'],
  ['fractionation', 'Fractionation'],
  ['propagation', 'Propagation'],
];
const TAGS = ['scar', 'review', 'gap'];

function num(v: string, fallback: number): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function MappingPanel() {
  void M.mapVersion.value;
  const s = M.session;
  const disp = M.mapDisplay.value;
  const last = M.latestBeat.value;
  if (!s) return null;
  const set = M.mapDisplay;
  const st = s.settings;
  const update = (patch: Partial<typeof st>) => {
    s.settings = { ...s.settings, ...patch };
    M.bump();
  };
  const reannotate = (patch: Partial<typeof st>) => {
    s.reannotateAll(patch);
    M.bump();
  };
  const mapped = s.mapPoints().length;
  return (
    <section class="panel">
      <h2>Mapping</h2>
      <div class="row">
        <button id="acquire" class="primary" disabled={!last} onClick={() => M.acquireNow()} title="Acquire from the latest beat (P)">Acquire point</button>
        <label class="check"><input id="auto-acquire" type="checkbox" checked={M.autoAcquire.value} onChange={(e) => (M.autoAcquire.value = e.currentTarget.checked)} /> Auto-acquire</label>
      </div>
      <p class={`small beat-status ${last ? (last.check.ok ? 'ok' : 'warn') : 'muted'}`} aria-live="polite">
        {last
          ? `Last beat: CL ${Number.isFinite(last.beat.cl) ? last.beat.cl.toFixed(0) : '—'} ms · ${last.beat.force.toFixed(0)} g · ${last.check.ok ? 'meets auto-acquire criteria' : last.check.reasons.join('; ')}`
          : 'Waiting for a reference beat… run the simulation.'}
      </p>
      <p class="muted small">{s.points.length} points ({mapped} on the map) · reference {S.referenceChannel.value}</p>

      <div class="segmented wrap" role="radiogroup" aria-label="Map type">
        {MAP_TYPES.map(([k, label]) => (
          <button key={k} role="radio" aria-checked={disp.type === k} class={disp.type === k ? 'on' : ''}
            onClick={() => { set.value = { ...disp, type: k }; S.overlay.value = 'map'; }}>{label}</button>
        ))}
      </div>
      {(disp.type === 'lat' || disp.type === 'propagation') && (
        <div class="row">
          <label class="check"><input type="checkbox" checked={disp.latRange === null} onChange={(e) => (set.value = { ...disp, latRange: e.currentTarget.checked ? null : [st.woi.start, st.woi.end] })} /> Auto range</label>
          {disp.latRange && (
            <>
              <input aria-label="LAT colour minimum" type="number" step={5} value={disp.latRange[0]} onChange={(e) => (set.value = { ...disp, latRange: [num(e.currentTarget.value, 0), disp.latRange![1]] })} />
              <input aria-label="LAT colour maximum" type="number" step={5} value={disp.latRange[1]} onChange={(e) => (set.value = { ...disp, latRange: [disp.latRange![0], num(e.currentTarget.value, 100)] })} />
            </>
          )}
        </div>
      )}
      {(disp.type === 'bipolar' || disp.type === 'unipolar') && (
        <div class="row">
          {(() => {
            const key = disp.type === 'bipolar' ? 'bipolarThresholds' : 'unipolarThresholds';
            const th = disp[key];
            return (
              <>
                <label>Scar &lt; (mV)<input id={`${key}-lo`} type="number" step={0.05} min={0} value={th[0]} onChange={(e) => (set.value = { ...disp, [key]: [num(e.currentTarget.value, th[0]), th[1]] })} /></label>
                <label>Normal &gt; (mV)<input id={`${key}-hi`} type="number" step={0.1} min={0} value={th[1]} onChange={(e) => (set.value = { ...disp, [key]: [th[0], num(e.currentTarget.value, th[1])] })} /></label>
              </>
            );
          })()}
        </div>
      )}
      <label>Fill threshold {st.fillThreshold} mm
        <input id="fill-threshold" type="range" min={2} max={30} step={1} value={st.fillThreshold} onInput={(e) => update({ fillThreshold: Number(e.currentTarget.value) })} />
      </label>
      <label>Projection cutoff {st.projectionCutoff} mm
        <input id="projection-cutoff" type="range" min={1} max={15} step={0.5} value={st.projectionCutoff} onInput={(e) => update({ projectionCutoff: Number(e.currentTarget.value) })} />
      </label>
      <div class="row wrap-row">
        <label class="check"><input type="checkbox" checked={disp.showPoints} onChange={(e) => (set.value = { ...disp, showPoints: e.currentTarget.checked })} /> Points</label>
        <label class="check"><input type="checkbox" checked={disp.cvVectors} onChange={(e) => (set.value = { ...disp, cvVectors: e.currentTarget.checked })} /> CV vectors</label>
        <label class="check"><input id="anatomy-build" type="checkbox" checked={M.anatomyBuild.value} onChange={(e) => { M.anatomyBuild.value = e.currentTarget.checked; if (e.currentTarget.checked) M.resetReveal(); }} /> Anatomy build</label>
      </div>

      <details>
        <summary>Annotation</summary>
        <div class="row">
          <label>WOI start (ms)<input id="woi-start" type="number" step={10} value={st.woi.start} onChange={(e) => reannotate({ woi: { ...st.woi, start: num(e.currentTarget.value, st.woi.start) } })} /></label>
          <label>WOI end (ms)<input id="woi-end" type="number" step={10} value={st.woi.end} onChange={(e) => reannotate({ woi: { ...st.woi, end: num(e.currentTarget.value, st.woi.end) } })} /></label>
        </div>
        <label>LAT
          <select id="lat-method" value={st.latMethod} onChange={(e) => reannotate({ latMethod: e.currentTarget.value as typeof st.latMethod })}>
            <option value="unipolar">Steepest unipolar downslope (−dV/dt)</option>
            <option value="bipolar">Bipolar peak</option>
          </select>
        </label>
      </details>
      <details>
        <summary>Auto-acquire criteria</summary>
        <div class="row">
          <label>Force min (g)<input type="number" min={0} max={60} value={st.filters.forceMin} onChange={(e) => update({ filters: { ...st.filters, forceMin: num(e.currentTarget.value, 5) } })} /></label>
          <label>max (g)<input type="number" min={0} max={80} value={st.filters.forceMax} onChange={(e) => update({ filters: { ...st.filters, forceMax: num(e.currentTarget.value, 40) } })} /></label>
        </div>
        <div class="row">
          <label>Tip SD ≤ (mm)<input type="number" min={0} step={0.1} value={st.filters.maxPositionSd} onChange={(e) => update({ filters: { ...st.filters, maxPositionSd: num(e.currentTarget.value, 1) } })} /></label>
          <label>CL ± (%)<input type="number" min={0} max={50} value={st.filters.clTolerance} onChange={(e) => update({ filters: { ...st.filters, clTolerance: num(e.currentTarget.value, 10) } })} /></label>
        </div>
        <label>Minimum point spacing (mm)<input type="number" min={0} step={0.5} value={st.filters.minSpacing} onChange={(e) => update({ filters: { ...st.filters, minSpacing: num(e.currentTarget.value, 2) } })} /></label>
      </details>

      <PointList />
      <PointInspector />
    </section>
  );
}

function PointList() {
  void M.mapVersion.value;
  const s = M.session!;
  const sel = M.selectedPoint.value;
  const mesh = S.mesh.value;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const flags = (p: MapPoint) => [p.ann.doublePotential ? 'DP' : '', p.ann.fractionated ? 'Frac' : '', p.ann.method === 'manual' ? 'M' : '', p.excluded ? 'Excl' : ''].filter(Boolean).join(' ');
  return (
    <details open>
      <summary>Points ({s.points.length})</summary>
      <div class="point-actions">
        <button disabled={sel === null} onClick={() => { if (sel !== null) { s.remove([sel]); M.selectedPoint.value = null; M.bump(); } }}>Delete</button>
        <button disabled={!s.canUndo()} onClick={() => { s.undo(); M.bump(); }} title="Undo (Ctrl+Z)">Undo</button>
        <button disabled={!s.points.length} onClick={() => { s.clear(); M.selectedPoint.value = null; M.bump(); }}>Clear all</button>
      </div>
      <div class="point-list" ref={listRef} role="listbox" aria-label="Acquired points">
        <table>
          <thead><tr><th>#</th><th>Region</th><th>LAT</th><th>Bip</th><th>Flags</th></tr></thead>
          <tbody>
            {s.points.slice(-400).map((p) => (
              <tr key={p.id} class={p.id === sel ? 'sel' : p.excluded || p.projectionDistance > s.settings.projectionCutoff ? 'dim' : ''} onClick={() => (M.selectedPoint.value = p.id)} role="option" aria-selected={p.id === sel}>
                <td>{p.id}</td>
                <td>{mesh ? REGIONS[mesh.region[p.vertex]!]?.name : ''}</td>
                <td>{Number.isFinite(p.ann.lat) ? p.ann.lat.toFixed(0) : '—'}</td>
                <td>{p.ann.bipolarVoltage.toFixed(2)}</td>
                <td>{flags(p)}{p.tags.length ? ` · ${p.tags.join(',')}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Stored EGMs of the selected point; click inside the WOI to set the LAT manually. */
function PointInspector() {
  void M.mapVersion.value;
  const id = M.selectedPoint.value;
  const s = M.session!;
  const p = id !== null ? s.get(id) : undefined;
  const cv = useRef<HTMLCanvasElement>(null);
  const span: [number, number] = [s.settings.woi.start - 60, s.settings.woi.end + 60];
  useEffect(() => {
    const c = cv.current;
    if (!c || !p) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#090f14';
    ctx.fillRect(0, 0, W, H);
    const w = p.window, fs = w.fs;
    const ref0 = (w.preMs + p.ann.refOffset) * fs / 1000;
    const x = (t: number) => ((t - span[0]) / (span[1] - span[0])) * W;
    ctx.fillStyle = 'rgba(45,212,191,0.08)';
    ctx.fillRect(x(s.settings.woi.start), 0, x(s.settings.woi.end) - x(s.settings.woi.start), H);
    const traces: Array<[Float32Array, string, string]> = [[w.ref, '#4fd1c1', 'ref'], [w.bip, '#f2b84b', 'bip'], [w.uni, '#ef8f5f', 'uni']];
    traces.forEach(([data, color, label], k) => {
      const y0 = (H / 3) * (k + 0.5);
      let peak = 0.05;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
      const g = (H / 3) * 0.45 / peak;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let px = 0; px < W; px++) {
        const t = span[0] + (px / W) * (span[1] - span[0]);
        const i = Math.round(ref0 + (t * fs) / 1000);
        if (i < 0 || i >= data.length) continue;
        const y = y0 - data[i]! * g;
        if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(label, 4, y0 - (H / 3) * 0.3);
    });
    if (Number.isFinite(p.ann.lat)) {
      ctx.strokeStyle = p.ann.method === 'manual' ? '#ffffff' : '#e0533d';
      ctx.setLineDash(p.ann.method === 'manual' ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x(p.ann.lat) + 0.5, 0);
      ctx.lineTo(x(p.ann.lat) + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
  if (!p) return <p class="muted small">Select a point (list or click its marker) to inspect and re-annotate it.</p>;
  return (
    <div class="inspector">
      <div class="inspector-head">
        <strong>Point {p.id}</strong>
        <span class="muted small">{p.electrode} · {p.force.toFixed(0)} g · proj {p.projectionDistance.toFixed(1)} mm{p.stable ? '' : ' · unstable'}</span>
      </div>
      <canvas ref={cv} class="inspector-canvas" aria-label="Point electrograms; click to set the activation time"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
          const t = span[0] + ((e.clientX - r.left) / r.width) * (span[1] - span[0]);
          s.setLat(p.id, Math.round(t * 2) / 2);
          M.bump();
        }} />
      <dl class="stats">
        <dt>LAT</dt><dd>{Number.isFinite(p.ann.lat) ? `${p.ann.lat.toFixed(1)} ms` : '—'} {p.ann.method === 'manual' ? '(manual)' : `(${p.ann.method})`}</dd>
        <dt>Bipolar / unipolar</dt><dd>{p.ann.bipolarVoltage.toFixed(2)} / {p.ann.unipolarVoltage.toFixed(2)} mV</dd>
        <dt>Deflections · duration</dt><dd>{p.ann.deflections} · {p.ann.duration.toFixed(0)} ms</dd>
        <dt>Flags</dt><dd>{[p.ann.doublePotential && 'double potential', p.ann.fractionated && 'fractionated'].filter(Boolean).join(', ') || 'none'}</dd>
      </dl>
      <div class="point-actions">
        <button disabled={p.ann.method !== 'manual'} onClick={() => { s.resetAnnotation(p.id); M.bump(); }}>Auto LAT</button>
        <button onClick={() => { s.setExcluded(p.id, !p.excluded); M.bump(); }}>{p.excluded ? 'Include' : 'Exclude'}</button>
        {TAGS.map((t) => (
          <button key={t} class={p.tags.includes(t) ? 'on' : ''} onClick={() => { s.toggleTag(p.id, t); M.bump(); }}>{t}</button>
        ))}
      </div>
    </div>
  );
}
