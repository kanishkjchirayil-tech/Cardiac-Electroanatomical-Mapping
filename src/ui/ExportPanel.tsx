import { useState } from 'preact/hooks';
import { DEFAULT_EGM_EXPORT, exportMesh, meshFields, pointRecords, toCsv, toPointsJson, type EgmExportOptions } from '../core/export/dataset';
import { SCENARIO_IDS, scenarioInfo, type ScenarioId } from '../core/scenarios/scenarios';
import { DEFAULT_BATCH, type BatchSpec } from '../engine/batch';
import { computeMap } from './map-compute';
import * as M from './mapping-state';
import * as C from './sim-client';
import * as S from './state';
import { download } from './download';

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** Dataset export: acquired points, the mesh with map values, and headless batch generation. */
export function ExportPanel() {
  const [egm, setEgm] = useState<EgmExportOptions>({ ...DEFAULT_EGM_EXPORT });
  const [gt, setGt] = useState(true);
  const [fmt, setFmt] = useState<'csv' | 'json'>('csv');
  const [meshFmt, setMeshFmt] = useState<'ply' | 'vtk'>('ply');
  const [busy, setBusy] = useState(false);
  void M.mapVersion.value;
  const n = M.session?.points.length ?? 0;
  const mesh = S.mesh.value;

  const exportPoints = async () => {
    if (!mesh || !M.session) return;
    setBusy(true);
    try {
      const labels = gt ? await C.requestLabels() : null;
      const recs = pointRecords(M.session.points, mesh, labels, egm);
      const sc = S.scenario.peek();
      const base = `ostium-points-${sc?.id ?? 'free'}-${stamp()}`;
      if (fmt === 'csv') download(`${base}.csv`, toCsv(recs), 'text/csv');
      else download(`${base}.json`, toPointsJson(recs, { scenario: sc?.id ?? null, seed: labels?.seed ?? 0, criticalLabel: labels?.criticalLabel ?? null, egm }));
    } finally {
      setBusy(false);
    }
  };

  const exportMeshFile = async () => {
    if (!mesh) return;
    setBusy(true);
    try {
      const labels = gt ? await C.requestLabels() : null;
      const has = !!M.session?.points.length;
      const maps = Object.fromEntries((['lat', 'bipolar', 'unipolar', 'fractionation'] as const).map((t) => [t, has ? computeMap(t)?.values ?? null : null]));
      const data = exportMesh(mesh, meshFields(mesh, maps, labels), meshFmt);
      download(`ostium-mesh-${stamp()}.${meshFmt}`, data, meshFmt === 'ply' ? 'application/octet-stream' : 'text/plain');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel">
      <h2>Export</h2>
      <p class="muted small">Ground-truth labels come from the hidden simulation state; they are added to exports only and never feed the maps.</p>
      <label class="check"><input id="exp-gt" type="checkbox" checked={gt} onChange={(e) => setGt(e.currentTarget.checked)} /> Include ground-truth labels</label>
      <fieldset class="band">
        <legend>Points ({n})</legend>
        <div class="row">
          <label>Format
            <select id="exp-fmt" value={fmt} onChange={(e) => setFmt(e.currentTarget.value as 'csv' | 'json')}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label>EGM rate
            <select id="exp-fs" value={String(egm.fs)} onChange={(e) => setEgm({ ...egm, fs: Number(e.currentTarget.value) as 1000 | 2000 })}>
              <option value="1000">1 kHz</option>
              <option value="2000">2 kHz</option>
            </select>
          </label>
        </div>
        <div class="row">
          <label>Before ref (ms)<input id="exp-pre" type="number" min={0} max={350} step={10} value={egm.preMs} onChange={(e) => setEgm({ ...egm, preMs: Math.max(0, Math.min(350, Number(e.currentTarget.value) || 0)) })} /></label>
          <label>After ref (ms)<input id="exp-post" type="number" min={10} max={350} step={10} value={egm.postMs} onChange={(e) => setEgm({ ...egm, postMs: Math.max(10, Math.min(350, Number(e.currentTarget.value) || 10)) })} /></label>
        </div>
        <button id="exp-points" disabled={!n || busy} onClick={() => void exportPoints()}>Export points</button>
      </fieldset>
      <fieldset class="band">
        <legend>Mesh with map values</legend>
        <div class="row">
          <label>Format
            <select id="exp-mesh-fmt" value={meshFmt} onChange={(e) => setMeshFmt(e.currentTarget.value as 'ply' | 'vtk')}>
              <option value="ply">PLY (binary)</option>
              <option value="vtk">VTK (legacy ASCII)</option>
            </select>
          </label>
          <button id="exp-mesh" disabled={!mesh || busy} onClick={() => void exportMeshFile()}>Export mesh</button>
        </div>
      </fieldset>
      <BatchSection />
    </section>
  );
}

function BatchSection() {
  const [spec, setSpec] = useState<BatchSpec>({ ...DEFAULT_BATCH });
  const running = S.batchRunning.value;
  const prog = S.batchProgress.value;
  const set = (patch: Partial<BatchSpec>) => setSpec({ ...spec, ...patch });
  const toggle = (id: ScenarioId | 'free', on: boolean) => {
    const next = on ? [...new Set([...spec.scenarios, id])] : spec.scenarios.filter((x) => x !== id);
    set({ scenarios: next.length ? next : ['free'] });
  };
  const needsRd = spec.scenarios.some((id) => id !== 'free' && scenarioInfo(id).requiresRd);
  const run = () => {
    const mesh = S.mesh.peek();
    if (!mesh) return;
    C.runBatch({ ...spec, mode: needsRd ? 'rd' : spec.mode }, mesh, (d, cancelled) => {
      if (d.cases.length) download(`ostium-batch-seed${spec.seed}-${d.cases.length}cases${cancelled ? '-partial' : ''}.json`, d);
    });
  };
  const frac = prog ? (prog.caseIndex + prog.points / Math.max(1, prog.pointsPerCase)) / Math.max(1, prog.cases) : 0;
  return (
    <fieldset class="band">
      <legend>Batch generation (headless)</legend>
      <div class="row">
        <label>Cases<input id="batch-n" type="number" min={1} max={500} value={spec.cases} onChange={(e) => set({ cases: Math.max(1, Number(e.currentTarget.value) | 0) })} /></label>
        <label>Base seed<input id="batch-seed" type="number" min={1} value={spec.seed} onChange={(e) => set({ seed: Math.max(1, Number(e.currentTarget.value) | 0) })} /></label>
        <label>Points/case<input id="batch-pts" type="number" min={1} max={1000} value={spec.pointsPerCase} onChange={(e) => set({ pointsPerCase: Math.max(1, Number(e.currentTarget.value) | 0) })} /></label>
      </div>
      <details>
        <summary class="small">Scenarios ({spec.scenarios.length})</summary>
        <label class="check small"><input type="checkbox" checked={spec.scenarios.includes('free')} onChange={(e) => toggle('free', e.currentTarget.checked)} /> Free (random tissue, sinus)</label>
        {SCENARIO_IDS.map((id) => (
          <label key={id} class="check small"><input type="checkbox" checked={spec.scenarios.includes(id)} onChange={(e) => toggle(id, e.currentTarget.checked)} /> {scenarioInfo(id).name}</label>
        ))}
      </details>
      <div class="row">
        <label>Engine
          <select id="batch-mode" value={needsRd ? 'rd' : spec.mode} disabled={needsRd} onChange={(e) => set({ mode: e.currentTarget.value as BatchSpec['mode'] })}>
            <option value="eikonal">Eikonal (fast, sinus)</option>
            <option value="rd">Reaction–diffusion</option>
          </select>
        </label>
        <label>Catheter
          <select id="batch-cath" value={spec.catheter} onChange={(e) => set({ catheter: e.currentTarget.value as BatchSpec['catheter'] })}>
            <option value="ablation">Ablation</option>
            <option value="grid">HD grid</option>
          </select>
        </label>
        <label>Anatomy
          <select id="batch-anat" value={String(spec.anatomyVariability)} onChange={(e) => set({ anatomyVariability: Number(e.currentTarget.value) })}>
            <option value="0">Current mesh</option>
            <option value="0.5">New, mild variation</option>
            <option value="1">New, typical variation</option>
          </select>
        </label>
      </div>
      <label class="check small"><input type="checkbox" checked={spec.randomAutonomic} onChange={(e) => set({ randomAutonomic: e.currentTarget.checked })} /> Random autonomic tone per case</label>
      <label class="check small"><input type="checkbox" checked={spec.includeMesh} onChange={(e) => set({ includeMesh: e.currentTarget.checked })} /> Include each case's mesh</label>
      {needsRd && <p class="muted small">The selected scenarios need the reaction–diffusion engine (slow without a GPU).</p>}
      {running ? (
        <>
          <div class="progress"><div style={{ width: `${Math.round(100 * frac)}%` }} /></div>
          <p class="small muted">Case {prog ? prog.caseIndex + 1 : 0} / {spec.cases} · {prog?.points ?? 0} / {spec.pointsPerCase} points</p>
          <button id="batch-cancel" onClick={C.cancelBatch}>Cancel (keep finished cases)</button>
        </>
      ) : (
        <button id="batch-run" class="primary" disabled={!S.mesh.value} onClick={run}>Run batch</button>
      )}
    </fieldset>
  );
}
