import { useEffect, useRef } from 'preact/hooks';
import { useSignalEffect, untracked } from '@preact/signals';
import { Viewer } from '../render/viewer';
import { standardViews, type ViewName } from '../render/views';
import { regionColors, scalarColors, shellColors, viridis, cssGradient, writeColors, voltageColor, latColor, FIBROTIC, UNMAPPED, SHELL_COLOR, LESION_CORE, LESION_BORDER, lesionTagColor, type RGB } from '../render/colormaps';
import { AblationPanel } from './AblationPanel';
import { PacingPanel } from './PacingPanel';
import { ScenarioPanel } from './ScenarioPanel';
import { ReportModal } from './ReportModal';
import { AutonomicPanel } from './AutonomicPanel';
import { ExportPanel } from './ExportPanel';
import { lesionGaps } from '../core/ablation/lesion';
import { initSimulation, latestVm } from './sim-client';
import { SimPanel } from './SimPanel';
import { CatheterPanel, SignalsPanel } from './CatheterPanel';
import { EgmPanel } from './EgmPanel';
import { MappingPanel } from './MappingPanel';
import * as M from './mapping-state';
import { computeMap, cvArrows, mapColors, type MapProduct } from './map-compute';
import { signal } from '@preact/signals';
import * as C from './sim-client';
import { walkOnSurface } from '../core/catheter/navigate';
import { vertexAdjacency, type Adjacency } from '../core/mesh/topology';
import { vToMv } from '../core/ep/ionic';
import { REGIONS, Region } from '../core/mesh/regions';
import { formatFromName, importMesh, parseMeshFile, type LabelSidecar } from '../core/mesh/io/import';
import { meshQuality } from '../core/mesh/quality';
import { loadProceduralAtrium } from './mesh-service';
import { Logo } from './Logo';
import * as S from './state';

const THICKNESS_RANGE: [number, number] = [0.5, 3.0];
const NARROW = typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches;

const ESOPHAGEAL_ZONE: RGB = [0.86, 0.74, 0.5];
/** Lesions from a previous procedure (scenario setup). */
const PRIOR_TAG: RGB = [0.55, 0.56, 0.6];
let teacherBuf = new Float32Array(0);
let mapBuf = new Float32Array(0);
/** Latest map product (recomputed when points or map settings change). */
let currentMap: MapProduct | null = null;
const mapProductVersion = signal(0);
const propagationPhase = signal(0);
let adjacency: Adjacency | null = null;

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
      writeColors(out, n, (i) => (a.lesion[i] === 2 ? LESION_CORE : a.fibrotic[i] ? FIBROTIC : a.last[i]! >= a.beatStart && Number.isFinite(a.last[i]!) ? latColor((a.last[i]! - r.lo) / span) : UNMAPPED));
      return out;
    }
    case 'substrate': {
      const a = S.gtActivation.value;
      if (!a || a.fibrotic.length !== n) return null;
      const kind = S.lesionKind.value ?? a.lesion;
      const zone = S.esophagealZone.value;
      writeColors(out, n, (i): RGB => (kind[i] === 2 ? LESION_CORE : kind[i] === 1 ? LESION_BORDER : a.fibrotic[i] ? FIBROTIC : zone?.[i] ? ESOPHAGEAL_ZONE : SHELL_COLOR));
      return out;
    }
    case 'autonomic': {
      const d = S.autonomicState.value?.density;
      if (!d || d.length !== n) return null;
      const kind = S.lesionKind.value;
      writeColors(out, n, (i): RGB => (kind?.[i] === 2 ? LESION_CORE : d[i]! > 0.02 ? viridis(d[i]!) : SHELL_COLOR));
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
    case 'map': {
      void mapProductVersion.value;
      if (!currentMap) return shellColors(m.region.length);
      if (mapBuf.length !== 3 * m.region.length) mapBuf = new Float32Array(3 * m.region.length);
      return mapColors(currentMap, mapBuf, currentMap.type === 'propagation' ? propagationPhase.value : undefined);
    }
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
    v.onSelect = (h) => C.placeRoving(h.vertex);
    v.onPointSelect = (id) => (M.selectedPoint.value = id);
    let lastDrag = -1;
    v.onDrag = (h) => {
      if (h.vertex !== lastDrag) C.placeRoving((lastDrag = h.vertex));
    };
    void generate();
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const views = standardViews();
      const i = Number(e.key) - 1;
      if (i >= 0 && i < views.length) {
        v.setView(views[i]!.name, S.obliqueDeg.value);
        return;
      }
      // Arrow keys nudge the roving tip along the wall in screen directions.
      const r = S.roving.peek(), m = S.mesh.peek();
      if (e.key.startsWith('Arrow') && r && m) {
        e.preventDefault();
        const { right, up } = v.screenAxes();
        const d = e.key === 'ArrowRight' ? right : e.key === 'ArrowLeft' ? right.map((x) => -x) : e.key === 'ArrowUp' ? up : up.map((x) => -x);
        adjacency ??= vertexAdjacency(m.indices, m.region.length);
        const to = walkOnSurface(m.positions, m.normals, adjacency, r.vertex, d as [number, number, number], e.shiftKey ? 0.5 : 2);
        if (to !== r.vertex) C.placeRoving(to);
      } else if (e.key === '[' || e.key === ']') {
        const f = S.rovingConfig.peek().force + (e.key === ']' ? 5 : -5);
        C.setRovingConfig({ force: Math.max(0, Math.min(60, f)) });
      } else if (e.key === 'p' || e.key === 'P') {
        if (M.acquireNow()) S.overlay.value = 'map';
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && M.selectedPoint.peek() !== null && M.session) {
        M.session.remove([M.selectedPoint.peek()!]);
        M.selectedPoint.value = null;
        M.bump();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && M.session?.canUndo()) {
        e.preventDefault();
        M.session.undo();
        M.bump();
      }
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
  useSignalEffect(() => {
    const r = S.rigInfo.value;
    if (r) viewer.current?.setCsCatheter(r.csPath, r.csElectrodes, r.transseptal);
  });
  useSignalEffect(() => viewer.current?.setRoving(S.roving.value));
  // Lesion tags coloured by quality, and red segments across interlesion gaps.
  useSignalEffect(() => {
    const v = viewer.current, ls = S.lesions.value, threshold = S.ablationSettings.value.gapThreshold;
    if (!v) return;
    if (!S.showLesionTags.value) return v.setLesionTags([], null);
    const mine = ls.filter((l) => !l.prior);
    const gaps = lesionGaps(mine, threshold);
    const seg = new Float32Array(gaps.length * 6);
    gaps.forEach((i, k) => { seg.set(mine[i - 1]!.center, 6 * k); seg.set(mine[i]!.center, 6 * k + 3); });
    v.setLesionTags(ls.map((l) => ({ position: l.center, color: l.prior ? PRIOR_TAG : l.active ? [1, 1, 1] : lesionTagColor(l.lqi), active: l.active })), seg);
  });
  useSignalEffect(() => {
    const r = S.rigInfo.value;
    viewer.current?.setEsophagus(S.showEsophagus.value && r ? r.esophagus.path : null, r?.esophagus.radius);
  });
  // Map products: recompute when points, settings or map display change.
  useSignalEffect(() => {
    void M.mapVersion.value;
    const disp = M.mapDisplay.value;
    void S.mesh.value;
    currentMap = M.session && M.session.points.length ? computeMap(disp.type) : null;
    // peek(): `.value++` would also read the signal and make this effect re-trigger itself.
    mapProductVersion.value = mapProductVersion.peek() + 1;
  });
  useSignalEffect(() => {
    void mapProductVersion.value;
    const v = viewer.current, s = M.session, m = S.mesh.value;
    const disp = M.mapDisplay.value;
    const sel = M.selectedPoint.value;
    if (!v || !m) return;
    const pts = s && disp.showPoints ? s.points : [];
    v.setPoints(pts.map((p) => ({
      id: p.id,
      position: [0, 1, 2].map((k) => m.positions[3 * p.vertex + k]!),
      color: currentMap?.pointColor.get(p.id) ?? [0.8, 0.8, 0.8],
      excluded: p.excluded || p.projectionDistance > (s?.settings.projectionCutoff ?? Infinity),
    })), sel);
    const showCv = disp.cvVectors && currentMap && (currentMap.type === 'lat' || currentMap.type === 'propagation');
    v.setCvArrows(showCv ? cvArrows(m, currentMap!.values) : null);
  });
  useSignalEffect(() => {
    void M.revealedVersion.value;
    viewer.current?.setVisibleMask(M.anatomyBuild.value ? M.revealed : null);
  });
  // Propagation animation: sweep the phase through the LAT range (≈ 2.5 s per cycle).
  useSignalEffect(() => {
    void mapProductVersion.value;
    if (S.overlay.value !== 'map' || M.mapDisplay.value.type !== 'propagation' || !currentMap) return;
    const [lo, hi] = currentMap.range;
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const span = hi - lo + 40;
      propagationPhase.value = lo - 10 + (((now - t0) / 2500) * span) % span;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
  useSignalEffect(() => {
    void S.mesh.value;
    adjacency = null;
  });

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
        <ScenarioPanel />
        <SimPanel />
        <CatheterPanel />
        <MappingPanel />
        <AblationPanel />
        <PacingPanel />
        <AutonomicPanel />
        <ExportPanel />
        <SignalsPanel />
        <AnatomyPanel />
        <DisplayPanel />
        <ClipPanel viewer={viewer} />
        <MeshInfoPanel />
      </aside>

      <div class="main-area">
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
      <EgmPanel />
      </div>

      <StatusBar />
      <ReportModal />
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
  const opts: Array<[S.Overlay, string]> = [['map', 'Map'], ['shell', 'Shell'], ['regions', 'Regions'], ['thickness', 'Thickness']];
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
  void mapProductVersion.value;
  if (!S.teacherView.value && S.overlay.value === 'map') {
    const mp = currentMap;
    const t = M.mapDisplay.value.type;
    const title = { lat: 'Local activation time (ms)', propagation: 'Propagation (LAT, ms)', bipolar: 'Bipolar voltage (mV)', unipolar: 'Unipolar voltage (mV)', fractionation: 'Fractionation (deflections)' }[t];
    const gradient = t === 'fractionation' ? cssGradient((x) => latColor(1 - x)) : cssGradient(latColor);
    return (
      <details class="legend" open={!NARROW}>
        <summary class="legend-title">{title}</summary>
        {mp ? (
          <>
            <div class="bar" style={{ background: gradient }} />
            <div class="bar-labels"><span>{mp.range[0].toFixed(t === 'lat' || t === 'propagation' ? 0 : 2)}</span><span>{mp.range[1].toFixed(t === 'lat' || t === 'propagation' ? 0 : 2)}</span></div>
            {(t === 'bipolar' || t === 'unipolar') && <div class="legend-note"><span class="swatch" style={{ background: 'rgb(77,79,84)' }} /> below {mp.range[0]} mV (scar)</div>}
            <div class="legend-note"><span class="swatch" style={{ background: 'rgb(158,158,163)' }} /> no data (beyond fill threshold)</div>
            {(t === 'lat' || t === 'propagation') && <div class="legend-note">relative to {S.referenceChannel.value}</div>}
          </>
        ) : <p class="muted small">No points yet: acquire points (P) to build a map.</p>}
      </details>
    );
  }
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
    if (ov === 'autonomic') {
      const st = S.autonomicState.value;
      return (
        <details class="legend teacher-legend" open>
          <summary class="legend-title">Teacher · GP innervation (phenomenological)</summary>
          <div class="bar" style={{ background: cssGradient(viridis) }} />
          <div class="bar-labels"><span>0</span><span>1</span></div>
          {st?.gps.map((g) => <div key={g.name} class="legend-note">{g.name}: {(100 * g.efficacy).toFixed(0)} % intact</div>)}
        </details>
      );
    }
    return (
      <details class="legend teacher-legend" open>
        <summary class="legend-title">Teacher · substrate</summary>
        <div class="legend-note"><span class="swatch" style={{ background: 'rgb(56,56,61)' }} /> fibrotic / inexcitable node</div>
        <div class="legend-note"><span class="swatch" style={{ background: 'rgb(107,26,36)' }} /> transmural lesion core</div>
        <div class="legend-note"><span class="swatch" style={{ background: 'rgb(219,140,153)' }} /> lesion border / partial thickness</div>
        <div class="legend-note"><span class="swatch" style={{ background: 'rgb(219,189,128)' }} /> esophageal zone</div>
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
        hoverText += a.lesion[h.vertex] === 2 ? ' · lesion core' : a.fibrotic[h.vertex] ? ' · fibrotic' : r && Number.isFinite(t) && t >= a.beatStart ? ` · true LAT ${(t - r.lo).toFixed(1)} ms` : ' · not activated';
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
