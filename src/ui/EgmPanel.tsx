import { useEffect, useRef, useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { cycleLength, detectActivations } from '../core/signals/detect';
import type { ChannelDef } from '../core/signals/recording';
import { egmStore } from './sim-client';
import * as S from './state';

const SWEEPS = [25, 50, 100, 200];
const PX_PER_MM = 96 / 25.4;
const LABEL_W = 78;

type GainKey = 'ecg' | 'cs' | 'map' | 'uni';
const DEFAULT_GAIN: Record<GainKey, number> = { ecg: 60, cs: 6, map: 6, uni: 3 };
const COLORS: Record<GainKey, string> = { ecg: '#d5dce3', cs: '#4fd1c1', map: '#f2b84b', uni: '#ef8f5f' };

const gainKey = (c: ChannelDef): GainKey => (c.kind === 'ecg' ? 'ecg' : c.group === 'cs' ? 'cs' : c.kind === 'unipolar' ? 'uni' : 'map');

/** Scrolling multi-channel EGM display ("sweep"), with calipers and a cycle-length readout. */
export function EgmPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [sweep, setSweep] = useState(100);
  const [gain, setGain] = useState(DEFAULT_GAIN);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [calipers, setCalipers] = useState<{ a: number; b: number } | null>(null);
  const [refName, setRefName] = useState('CS 7-8');
  const [cl, setCl] = useState<number>(NaN);
  const rig = S.rigInfo.value;
  const channels = rig?.channels ?? [];
  const view = useRef({ tRight: 0, widthMs: 1000 });
  const state = useRef({ sweep, gain, frozenAt, calipers });
  state.current = { sweep, gain, frozenAt, calipers };
  const raf = useRef(0);

  /**
   * Incremental sweep rendering: pixel column c shows the min–max envelope of samples in
   * [c, c+1)/pxPerMs (plus the previous sample, for continuity), drawn as a 1-px fillRect. New data
   * scrolls the existing image left and only the new columns are drawn; settings changes, resizes
   * and freeze/unfreeze trigger a full redraw.
   */
  const drawn = useRef<{ key: string; lastCol: number } | null>(null);
  const draw = () => {
    raf.current = 0;
    const cv = canvasRef.current, ov = overlayRef.current;
    if (!cv || !ov) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    let resized = false;
    for (const c of [cv, ov]) {
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
        resized = true;
      }
    }
    const st = state.current;
    const traceW = Math.max(0, Math.floor(W - LABEL_W));
    const pxPerMs = (st.sweep * PX_PER_MM) / 1000;
    const tRight = st.frozenAt ?? (egmStore.total ? egmStore.tEnd : 0);
    const lastCol = Math.floor(tRight * pxPerMs);
    const firstCol = lastCol - traceW + 1;
    view.current = { tRight: (lastCol + 1) / pxPerMs, widthMs: traceW / pxPerMs };
    const key = `${W}x${H}:${dpr}:${st.sweep}:${JSON.stringify(st.gain)}:${channels.length}:${egmStore.t0}:${st.frozenAt}`;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = getComputedStyle(cv).getPropertyValue('--egm-bg').trim() || '#090f14';
    const prev = drawn.current;
    let from = firstCol;
    if (!resized && prev && prev.key === key && prev.lastCol <= lastCol && lastCol - prev.lastCol < traceW) {
      const shift = lastCol - prev.lastCol;
      if (shift === 0) { drawOverlay(); return; }
      // Scroll the trace area left by `shift` columns (device pixels), keep the label column.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(cv, Math.round((LABEL_W + shift) * dpr), 0, Math.round((traceW - shift) * dpr), cv.height, Math.round(LABEL_W * dpr), 0, Math.round((traceW - shift) * dpr), cv.height);
      ctx.restore();
      from = prev.lastCol + 1;
    } else {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }
    drawn.current = { key, lastCol };
    const x0 = LABEL_W + (from - firstCol);
    ctx.fillStyle = bg;
    ctx.fillRect(x0, 0, W - x0, H);
    const n = channels.length;
    if (!n) return;
    const rowH = (H - 16) / n;
    // Time grid for the new columns.
    for (let col = from; col <= lastCol; col++) {
      const t0 = col / pxPerMs, t1 = (col + 1) / pxPerMs;
      const k100 = Math.floor(t1 / 100);
      if (Math.floor(t0 / 100) === k100 || t0 < 0) continue;
      const major = k100 % 5 === 0;
      const x = LABEL_W + (col - firstCol);
      ctx.fillStyle = major ? 'rgba(130,149,165,0.28)' : 'rgba(130,149,165,0.12)';
      ctx.fillRect(x, 0, 1, H - 14);
      if (major) {
        ctx.fillStyle = 'rgba(130,149,165,0.85)';
        ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText(`${((k100 * 100) / 1000).toFixed(1)} s`, x + 3, H - 3);
      }
    }
    const fs = egmStore.fs;
    for (let c = 0; c < n; c++) {
      const ch = channels[c]!;
      const gk = gainKey(ch);
      const y0 = rowH * (c + 0.5);
      const k = st.gain[gk] * PX_PER_MM;
      const top = y0 - rowH * 0.95, bot = y0 + rowH * 0.95;
      if (from === firstCol) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, y0 - rowH / 2, LABEL_W, rowH);
        ctx.fillStyle = COLORS[gk];
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(ch.name, 6, y0 + 4);
      }
      if (!egmStore.total) continue;
      ctx.fillStyle = COLORS[gk];
      for (let col = from; col <= lastCol; col++) {
        const ia = Math.max(egmStore.first, Math.floor(((col / pxPerMs - egmStore.t0) * fs) / 1000) - 1);
        const ib = Math.min(egmStore.total, Math.ceil((((col + 1) / pxPerMs - egmStore.t0) * fs) / 1000));
        if (ib <= ia) continue;
        let mn = Infinity, mx = -Infinity;
        for (let i = ia; i < ib; i++) {
          const v = egmStore.at(c, i);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const yTop = Math.max(top, y0 - mx * k), yBot = Math.min(bot, y0 - mn * k);
        if (yBot < top || yTop > bot) continue;
        ctx.fillRect(LABEL_W + (col - firstCol), yTop, 1.25, Math.max(1.25, yBot - yTop));
      }
    }
    drawOverlay();
  };

  /** Calipers on a separate transparent canvas (cheap to redraw). */
  const drawOverlay = () => {
    const ov = overlayRef.current;
    if (!ov) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = ov.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
    const cal = state.current.calipers;
    if (!cal) return;
    const pxPerMs = (state.current.sweep * PX_PER_MM) / 1000;
    const { tRight, widthMs } = view.current;
    ctx.strokeStyle = '#f2b84b';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const t of [cal.a, cal.b]) {
      const x = Math.round(LABEL_W + (t - (tRight - widthMs)) * pxPerMs) + 0.5;
      if (x < LABEL_W || x > ov.clientWidth) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ov.clientHeight - 14); ctx.stroke();
    }
  };

  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  };

  // Redraw on new samples, settings changes and resize.
  useSignalEffect(() => {
    void S.egmVersion.value;
    void S.rigInfo.value;
    schedule();
  });
  useEffect(schedule, [sweep, gain, frozenAt, calipers]);
  useEffect(() => {
    const ro = new ResizeObserver(schedule);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  // Cycle length from the reference channel, twice a second.
  useEffect(() => {
    const id = setInterval(() => {
      const c = channels.findIndex((ch) => ch.name === refName);
      if (c < 0 || egmStore.total < egmStore.fs) return setCl(NaN);
      const x = egmStore.slice(c, egmStore.total - 6 * egmStore.fs, egmStore.total);
      setCl(cycleLength(detectActivations(x, egmStore.fs), egmStore.fs));
    }, 500);
    return () => clearInterval(id);
  }, [refName, channels.length]);

  const timeAtX = (clientX: number) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const pxPerMs = (sweep * PX_PER_MM) / 1000;
    const { tRight, widthMs } = view.current;
    return tRight - widthMs + (clientX - r.left - LABEL_W) / pxPerMs;
  };
  const drag = useRef<{ x: number; a: number } | null>(null);

  const bump = (k: GainKey, f: number) => setGain((g) => ({ ...g, [k]: Math.max(0.5, Math.min(400, g[k] * f)) }));
  const caliperMs = calipers ? Math.abs(calipers.b - calipers.a) : null;
  const csNames = channels.filter((c) => c.group === 'cs').map((c) => c.name);

  return (
    <section class="egm-panel" aria-label="Electrograms">
      <div class="egm-toolbar">
        <strong>Electrograms</strong>
        <div class="segmented compact" role="radiogroup" aria-label="Sweep speed">
          {SWEEPS.map((v) => (
            <button key={v} role="radio" aria-checked={sweep === v} class={sweep === v ? 'on' : ''} onClick={() => setSweep(v)}>{v}</button>
          ))}
        </div>
        <span class="muted small">mm/s</span>
        <span class="gain-group">
          {(['ecg', 'cs', 'map', 'uni'] as GainKey[]).map((k) => (
            <span key={k} class="gain" style={{ color: COLORS[k] }}>
              {k.toUpperCase()}
              <button aria-label={`Decrease ${k} gain`} onClick={() => bump(k, 1 / 1.5)}>−</button>
              <button aria-label={`Increase ${k} gain`} onClick={() => bump(k, 1.5)}>+</button>
            </span>
          ))}
        </span>
        <button id="egm-freeze" class={frozenAt !== null ? 'on' : ''} onClick={() => setFrozenAt(frozenAt === null ? egmStore.tEnd : null)}>
          {frozenAt !== null ? 'Live' : 'Freeze'}
        </button>
        <label class="inline">Ref
          <select id="egm-ref" value={refName} onChange={(e) => setRefName(e.currentTarget.value)}>
            {csNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span class="readout">CL {Number.isFinite(cl) ? `${cl.toFixed(0)} ms` : '—'}</span>
        <span class="readout caliper">{caliperMs !== null ? `Caliper ${caliperMs.toFixed(0)} ms (${(60000 / caliperMs).toFixed(0)} bpm)` : 'Drag on traces to measure'}</span>
      </div>
      <div class="egm-stage">
      <canvas ref={canvasRef} class="egm-canvas" aria-hidden="true" />
      <canvas
        ref={overlayRef}
        class="egm-overlay"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
          const t = timeAtX(e.clientX);
          drag.current = { x: e.clientX, a: t };
          setCalipers({ a: t, b: t });
        }}
        onPointerMove={(e) => {
          if (drag.current) setCalipers({ a: drag.current.a, b: timeAtX(e.clientX) });
        }}
        onPointerUp={(e) => {
          if (drag.current && Math.abs(e.clientX - drag.current.x) < 3) setCalipers(null);
          drag.current = null;
        }}
      />
      </div>
    </section>
  );
}
