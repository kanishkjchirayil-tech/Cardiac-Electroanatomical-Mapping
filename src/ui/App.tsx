import { useEffect, useRef } from 'preact/hooks';
import { useSignalEffect, untracked } from '@preact/signals';
import { Viewer } from '../render/viewer';
import { standardViews, type ViewName } from '../render/views';
import { regionColors, scalarColors, shellColors, viridis, cssGradient, writeColors, voltageColor, latColor, FIBROTIC, UNMAPPED, SHELL_COLOR } from '../render/colormaps';
import { initSimulation, latestVm } from './sim-client';
import { SimPanel } from './SimPanel';
import { vToMv } from '../core/ep/ionic';
import { REGIONS, Region } from '../core/mesh/regions';
import { formatFromName, importMesh, parseMeshFile, type LabelSidecar } from '../core/mesh/io/import';
import { meshQuality } from '../core/mesh/quality';
import { loadProceduralAtrium } from './mesh-service';
import { Logo } from './Logo';
import * as S from './state';

const THICKNESS_RANGE: [number, number] = [0.5, 3.0];
const NARROW = typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches;

let teacherBuf = new Float32Array(0);

/** Range of the true activation map for the most recent beat (teacher view only). */
function latRange(): { lo: number; hi: number } | null {
  const a = S.gtActivation.value;
  if (!a) return null;
  let lo = Infinity, hi = -Infinity;
  for (const x of a.last) if (Number.isFinite(x) && x >= a.beatStart) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

function teacherColors(n: number): Float32Array | null {
  if (teacherBuf.length !== 3 * n) teacherBuf = new Float32Array(3 * n);
  const out = teacherBuf;
  switch (S.teacherOverlay.value) {
    case 'vm': {
      void S.vmFrameId.value;
      const vm = latestVm;
      if (!vm || vm.length !== n) return null;
      writeColors(out, n, (i) => voltageColor(vm[i]!));
      return out;
    }
    case 'lat': {
      const a = S.gtActivation.value, r = latRange();
      if (!a || !r || a.last.length !== n) return null;
      const span = Math.max(1, r.hi - r.lo);
      writeColors(out, n, (i) => (a.fibrotic[i] ? FIBROTIC : a.last[i]! >= a.beatStart && Number.isFinite(a.last[i]!) ? latColor((a.last[i]! - r.lo) / span) : UNMAPPED));
      return out;
    }
    case 'substrate': {
      const a = S.gtActivation.value;
      if (!a || a.fibrotic.length !== n) return null;
      writeColors(out, n, (i) => (a.fibrotic[i] ? FIBROTIC : SHELL_COLOR));
      return out;
    }
  }
}

function colorsFor(): Float32Array | null {
  const m = S.mesh.value;
  if (!m) return null;
  if (S.teacherView.value) {
    const c = teacherColors(m.region.length);
    if (c) return c;
  }
  switch (S.overlay.value) {
    case 'shell': return shellColors(m.region.length);
    case 'regions': return regionColors(m.region, S.highlightRegion.value);
    case 'thickness': return scalarColors(m.wallThickness, THICKNESS_RANGE[0], THICKNESS_RANGE[1]);
  }
}

async function generate(): Promise<void> {
  S.errorMsg.value = null;
  S.loading.value = { stage: 'starting', fraction: 0 };
  try {
    const r = await loadProceduralAtrium(
      { seed: S.genSeed.value, variability: S.genVariability.value },
      (stage, fraction) => (S.loading.value = { stage, fraction }),
    );
    S.importWarnings.value = [];
    S.quality.value = r.quality;
    S.meshSource.value = `Procedural LA · seed ${S.genSeed.value} · variability ${S.genVariability.value}${r.fromCache ? ' (cached)' : ''}`;
    S.mesh.value = r.mesh;
  } catch (e) {
    S.errorMsg.value = `Mesh generation failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    S.loading.value = null;
  }
}

async function importFiles(files: FileList): Promise<void> {
  S.errorMsg.value = null;
  const list = Array.from(files);
  const meshFile = list.find((f) => formatFromName(f.name));
  const sideFile = list.find((f) => f.name.toLowerCase().endsWith('.json'));
  if (!meshFile) {
    S.errorMsg.value = 'Choose an .obj, .ply or .vtk file (optionally together with a labels .json sidecar).';
    return;
  }
  try {
    const raw = parseMeshFile(formatFromName(meshFile.name)!, new Uint8Array(await meshFile.arrayBuffer()));
    const sidecar = sideFile ? (JSON.parse(await sideFile.text()) as LabelSidecar) : null;
    const { mesh, warnings } = importMesh(raw, sidecar);
    S.importWarnings.value = warnings;
    S.quality.value = meshQuality(mesh.positions, mesh.indices);
    S.meshSource.value = `Imported ${meshFile.name}${sideFile ? ` + ${sideFile.name}` : ''}`;
    S.mesh.value = mesh;
  } catch (e) {
    S.errorMsg.value = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);

  useEffect(() => {
    const v = new Viewer(host.current!);
    viewer.current = v;
    v.onHover = (h) => (S.hover.value = h);
    v.onFps = (f) => (S.fps.value = f);
    void generate();
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const views = standardViews();
      const i = Number(e.key) - 1;
      if (i >= 0 && i < views.length) v.setView(views[i]!.name, S.obliqueDeg.value);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      v.dispose();
    };
  }, []);

  // Mesh changes → rebuild geometry and reset to AP.
  useSignalEffect(() => {
    const m = S.mesh.value;
    const v = viewer.current;
    if (!m || !v) return;
    // Only the mesh is a dependency here; colours are tracked by the effect below.
    untracked(() => {
      v.setMesh(m, colorsFor()!);
      v.setView('AP', S.obliqueDeg.peek());
      initSimulation(m);
    });
  });
  useSignalEffect(() => {
    const c = colorsFor();
    if (c) viewer.current?.setColors(c);
  });
  useSignalEffect(() => viewer.current?.setWireframe(S.wireframe.value));
  useSignalEffect(() => viewer.current?.setLabelsVisible(S.showLabels.value));
  useSignalEffect(() => viewer.current?.setOpacity(S.opacity.value));
  useSignalEffect(() => viewer.current?.setClip(S.clip.value));

  return (
    <div class="app">
      <header class="topbar">
        <Logo />
        <div class="brand">
          <span class="brand-name">Ostium</span>
          <span class="brand-sub">atrial mapping &amp; ablation simulator</span>
        </div>
        <div class="spacer" />
        <div class="disclaimer" role="note">Educational simulation — not for clinical use</div>
      </header>

      <aside class="sidebar">
        <SimPanel />
        <AnatomyPanel />
        <DisplayPanel />
        <ClipPanel viewer={viewer} />
        <MeshInfoPanel />
      </aside>

      <main class="viewport" ref={host}>
        <ViewToolbar viewer={viewer} />
        <Legend />
        <div class="watermark">Educational simulation — not for clinical use</div>
        {S.loading.value && (
          <div class="loading">
            <div>Building atrium… {S.loading.value.stage}</div>
            <div class="progress"><div style={{ width: `${Math.round(S.loading.value.fraction * 100)}%` }} /></div>
          </div>
        )}
        {S.errorMsg.value && <div class="error" role="alert">{S.errorMsg.value}</div>}
      </main>

      <StatusBar />
    </div>
  );
}

function Panel({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <section class="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function AnatomyPanel() {
  return (
    <Panel title="Anatomy">
      <div class="row">
        <label>Seed <input type="number" value={S.genSeed.value} onInput={(e) => (S.genSeed.value = Number(e.currentTarget.value) | 0)} /></label>
        <label>Variability
          <input type="number" min={0} max={2} step={0.25} value={S.genVariability.value}
            onInput={(e) => (S.genVariability.value = Math.max(0, Math.min(2, Number(e.currentTarget.value))))} />
        </label>
      </div>
      <button class="primary" disabled={!!S.loading.value} onClick={() => void generate()}>Generate procedural LA</button>
      <label class="file">
        Import mesh (.obj/.ply/.vtk + labels .json)
        <input type="file" multiple accept=".obj,.ply,.vtk,.json"
          onChange={(e) => { const f = e.currentTarget.files; if (f?.length) void importFiles(f); e.currentTarget.value = ''; }} />
      </label>
      <p class="muted small">{S.meshSource.value}</p>
      {S.importWarnings.value.length > 0 && (
        <ul class="warnings">{S.importWarnings.value.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
    </Panel>
  );
}

function DisplayPanel() {
  const opts: Array<[S.Overlay, string]> = [['shell', 'Shell'], ['regions', 'Regions'], ['thickness', 'Wall thickness']];
  return (
    <Panel title="Display">
      <div class="segmented" role="radiogroup" aria-label="Overlay">
        {opts.map(([k, label]) => (
          <button key={k} role="radio" aria-checked={S.overlay.value === k} class={S.overlay.value === k ? 'on' : ''} onClick={() => (S.overlay.value = k)}>
            {label}
          </button>
        ))}
      </div>
      <label class="check"><input type="checkbox" checked={S.wireframe.value} onChange={(e) => (S.wireframe.value = e.currentTarget.checked)} /> Wireframe</label>
      <label class="check"><input type="checkbox" checked={S.showLabels.value} onChange={(e) => (S.showLabels.value = e.currentTarget.checked)} /> Opening labels</label>
      <label>Opacity {S.opacity.value.toFixed(2)}
        <input type="range" min={0.2} max={1} step={0.05} value={S.opacity.value} onInput={(e) => (S.opacity.value = Number(e.currentTarget.value))} />
      </label>
    </Panel>
  );
}

function ClipPanel({ viewer }: { viewer: { current: Viewer | null } }) {
  const c = S.clip.value;
  const set = (patch: Partial<typeof c>) => (S.clip.value = { ...c, ...patch });
  const r = Math.ceil(viewer.current?.meshRadius ?? 60);
  return (
    <Panel title="Clipping plane">
      <label class="check"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} /> Enable</label>
      <label>Orientation
        <select value={c.axis} onChange={(e) => set({ axis: e.currentTarget.value as typeof c.axis })}>
          <option value="view">View-aligned</option>
          <option value="LR">Left–right (sagittal)</option>
          <option value="AP">Anterior–posterior (coronal)</option>
          <option value="SI">Superior–inferior (axial)</option>
        </select>
      </label>
      <label>Offset {c.offset.toFixed(0)} mm
        <input type="range" min={-r} max={r} step={1} value={c.offset} onInput={(e) => set({ offset: Number(e.currentTarget.value) })} />
      </label>
      <div class="row">
        <label class="check"><input type="checkbox" checked={c.flip} onChange={(e) => set({ flip: e.currentTarget.checked })} /> Flip side</label>
        <button disabled={c.axis !== 'view' || !c.enabled} onClick={() => viewer.current?.alignClipToView()}>Align to view</button>
      </div>
    </Panel>
  );
}

function MeshInfoPanel() {
  const q = S.quality.value;
  const m = S.mesh.value;
  if (!q || !m) return null;
  return (
    <Panel title="Mesh">
      <dl class="stats">
        <dt>Vertices</dt><dd>{q.vertices.toLocaleString()}</dd>
        <dt>Triangles</dt><dd>{q.triangles.toLocaleString()}</dd>
        <dt>Mean edge</dt><dd>{q.meanEdge.toFixed(2)} mm</dd>
        <dt>Min angle</dt><dd>{q.minAngleDeg.toFixed(1)}°</dd>
        <dt>Area</dt><dd>{(q.area / 100).toFixed(0)} cm²</dd>
        <dt>Openings</dt><dd>{m.boundaryLoops.map((l) => l.label).join(', ') || 'none'}</dd>
        <dt>Manifold</dt><dd>{q.nonManifoldEdges === 0 && q.duplicateHalfEdges === 0 ? 'yes' : 'NO'}</dd>
      </dl>
    </Panel>
  );
}

function ViewToolbar({ viewer }: { viewer: { current: Viewer | null } }) {
  return (
    <div class="view-toolbar" role="toolbar" aria-label="Standard views">
      {standardViews(S.obliqueDeg.value).map((v, i) => (
        <button key={v.name} title={`${v.label} (key ${i + 1})`} onClick={() => viewer.current?.setView(v.name as ViewName, S.obliqueDeg.value)}>
          {v.name}
        </button>
      ))}
    </div>
  );
}

function Legend() {
  const m = S.mesh.value;
  if (!m) return null;
  if (S.teacherView.value) {
    const ov = S.teacherOverlay.value;
    if (ov === 'vm') {
      return (
        <details class="legend teacher-legend" open>
          <summary class="legend-title">Teacher · transmembrane voltage</summary>
          <div class="bar" style={{ background: cssGradient(voltageColor) }} />
          <div class="bar-labels"><span>−80 mV</span><span>+20 mV</span></div>
        </details>
      );
    }
    if (ov === 'lat') {
      const r = latRange();
      return (
        <details class="legend teacher-legend" open>
          <summary class="legend-title">Teacher · true activation (last beat)</summary>
          <div class="bar" style={{ background: cssGradient(latColor) }} />
          <div class="bar-labels"><span>{r ? '0 ms' : '—'}</span><span>{r ? `${(r.hi - r.lo).toFixed(0)} ms` : 'run the simulation'}</span></div>
          <div class="legend-note"><span class="swatch" style={{ background: 'rgb(56,56,61)' }} /> fibrotic / inexcitable</div>
        </details>
      );
    }
    return (
      <details class="legend teacher-legend" open>
        <summary class="legend-title">Teacher · substrate</summary>
        <div class="legend-note"><span class="swatch" style={{ background: 'rgb(56,56,61)' }} /> fibrotic / inexcitable node</div>
      </details>
    );
  }
  if (S.overlay.value === 'thickness') {
    return (
      <details class="legend" open>
        <summary class="legend-title">Wall thickness (mm)</summary>
        <div class="bar" style={{ background: cssGradient(viridis) }} />
        <div class="bar-labels"><span>{THICKNESS_RANGE[0]}</span><span>{THICKNESS_RANGE[1]}+</span></div>
      </details>
    );
  }
  if (S.overlay.value !== 'regions') return null;
  const present = new Set(m.region);
  return (
    <details class="legend" open={!NARROW} onMouseLeave={() => (S.highlightRegion.value = null)}>
      <summary class="legend-title">Regions <span class="muted">(hover to highlight)</span></summary>
      <ul>
        {REGIONS.filter((r) => present.has(r.id)).map((r) => (
          <li key={r.id} onMouseEnter={() => (S.highlightRegion.value = r.id)}>
            <span class="swatch" style={{ background: `rgb(${r.color.map((c) => Math.round(c * 255)).join(',')})` }} />
            {r.name}
          </li>
        ))}
      </ul>
    </details>
  );
}

function StatusBar() {
  const h = S.hover.value;
  const m = S.mesh.value;
  let hoverText = 'Hover the shell for region, wall thickness and position · keys 1–8: views · drag: rotate · right-drag: pan · wheel: zoom';
  if (h && m) {
    const r = REGIONS[m.region[h.vertex]!]?.name ?? REGIONS[Region.Unlabeled]!.name;
    hoverText = `${r} · wall ${m.wallThickness[h.vertex]!.toFixed(2)} mm · vertex ${h.vertex} · (${h.point.map((x) => x.toFixed(1)).join(', ')}) mm LPS`;
    if (S.teacherView.value) {
      void S.vmFrameId.value;
      const a = S.gtActivation.value;
      if (S.teacherOverlay.value === 'vm' && latestVm) hoverText += ` · Vm ${vToMv(latestVm[h.vertex] ?? 0).toFixed(0)} mV`;
      if (S.teacherOverlay.value === 'lat' && a) {
        const r = latRange();
        const t = a.last[h.vertex]!;
        hoverText += a.fibrotic[h.vertex] ? ' · fibrotic' : r && Number.isFinite(t) && t >= a.beatStart ? ` · true LAT ${(t - r.lo).toFixed(1)} ms` : ' · not activated';
      }
    }
  }
  return (
    <footer class="statusbar">
      <span>{hoverText}</span>
      <span class="spacer" />
      <span>sim {(S.simTime.value / 1000).toFixed(2)} s{S.simRunning.value ? ` · ${S.simSpeed.value.toFixed(2)}×` : ' · paused'}</span>
      <span>{S.fps.value > 0 ? `${S.fps.value.toFixed(0)} fps` : "idle"}</span>
    </footer>
  );
}
