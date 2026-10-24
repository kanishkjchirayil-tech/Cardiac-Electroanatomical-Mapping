import { evaluateCase, type MapSummary } from '../core/scenarios/report';
import { PV_NAMES, type PvName } from '../core/mesh/regions';
import type { Vec3 } from '../core/math/vec3';
import { computeMap } from './map-compute';
import * as M from './mapping-state';
import * as S from './state';

function mapSummary(): MapSummary {
  const m = S.mesh.peek()!;
  const s = M.session;
  const points = (s?.points ?? []).map((p) => ({ time: p.time, vertex: p.vertex, position: p.location, region: m.region[p.vertex]!, lat: p.ann.lat, bipolar: p.ann.bipolarVoltage, excluded: p.excluded }));
  const lat = s && s.points.length ? computeMap('lat') : null;
  let covered = 0, earliest: Vec3 | null = null, best = Infinity;
  if (lat) {
    lat.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      covered++;
      if (v < best) { best = v; earliest = [m.positions[3 * i]!, m.positions[3 * i + 1]!, m.positions[3 * i + 2]!]; }
    });
  }
  const q = S.quality.peek();
  return { points, coverage: covered / m.region.length, earliest, areaCm2: q ? q.area / 100 : 0 };
}

/** End-of-case report (ground truth revealed). */
export function ReportModal() {
  if (!S.reportOpen.value) return null;
  const gt = S.caseReport.value;
  const m = S.mesh.value;
  if (!gt || !m) return null;
  const pvCentre = Object.fromEntries(PV_NAMES.map((pv) => [pv, (m.anatomy?.pvs.find((p) => p.name === pv)?.ostiumCenter ?? [0, 0, 0]) as Vec3])) as Record<PvName, Vec3>;
  const ev = evaluateCase(gt, mapSummary(), S.lesions.value, pvCentre, S.ablationSettings.value.gapThreshold);
  const download = () => {
    const blob = new Blob([JSON.stringify({ evaluation: ev, groundTruth: gt }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ostium-case-${gt.scenario?.id ?? 'free'}-${gt.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Case report" onClick={(e) => { if (e.target === e.currentTarget) S.reportOpen.value = false; }}>
      <div class="modal report">
        <header class="report-head">
          <h2>End-of-case report</h2>
          <button aria-label="Close" onClick={() => (S.reportOpen.value = false)}>✕</button>
        </header>
        <p class="small">{gt.scenario ? <><strong>{gt.scenario.name}</strong> · seed {gt.seed}</> : 'Free simulation'}</p>
        {gt.scenario && (
          <>
            <p class={`verdict ${ev.success ? 'ok' : 'fail'}`}>{ev.success ? 'All success criteria met' : 'Not all success criteria met'}</p>
            <ul class="criteria-list">
              {ev.criteria.map((c) => <li key={c.label} class={c.passed ? 'ok' : 'fail'}><span class="mark">{c.passed ? '✓' : '✗'}</span> <strong>{c.label}</strong><br /><span class="muted">{c.detail}</span></li>)}
            </ul>
          </>
        )}
        <div class="report-grid">
          <section>
            <h3>Map quality</h3>
            <dl class="stats">
              <dt>Points (included)</dt><dd>{ev.map.points} ({ev.map.included})</dd>
              <dt>Surface coverage</dt><dd>{(100 * ev.map.coverage).toFixed(0)} %</dd>
              <dt>Density</dt><dd>{ev.map.density.toFixed(1)} /cm²</dd>
            </dl>
          </section>
          <section>
            <h3>Lesion set</h3>
            <dl class="stats">
              <dt>New lesions</dt><dd>{ev.lesions.user}{ev.lesions.prior ? ` (+${ev.lesions.prior} prior)` : ''}</dd>
              <dt>RF time</dt><dd>{ev.lesions.rfSeconds.toFixed(0)} s</dd>
              <dt>Mean LQI</dt><dd>{ev.lesions.meanLqi.toFixed(1)}</dd>
              <dt>Below target / gaps</dt><dd>{ev.lesions.belowTarget} / {ev.lesions.gaps}</dd>
            </dl>
          </section>
          <section>
            <h3>Block (ground truth)</h3>
            <dl class="stats">
              {gt.chamber === 'RA' ? (
                <><dt>Cavotricuspid isthmus</dt><dd>{gt.ctiBlock.durable ? 'blocked' : gt.ctiBlock.now ? 'blocked (edema)' : 'conducting'}</dd></>
              ) : (
                <>
                  {gt.pv.map((p) => <><dt key={p.pv}>{p.pv}</dt><dd>{p.durable ? 'isolated' : p.isolated ? 'isolated (edema only)' : `connected (${(100 * p.connected).toFixed(0)} %)`}</dd></>)}
                  <dt>Mitral isthmus</dt><dd>{gt.mitralBlock.durable ? 'blocked' : gt.mitralBlock.now ? 'blocked (edema)' : 'conducting'}</dd>
                  <dt>Roof</dt><dd>{gt.roofBlock.durable ? 'blocked' : gt.roofBlock.now ? 'blocked (edema)' : 'conducting'}</dd>
                </>
              )}
              <dt>Rhythm now</dt><dd>{gt.rhythm === 'sinus' ? 'sinus' : 'not sinus'}</dd>
            </dl>
          </section>
          <section>
            <h3>Procedure</h3>
            <dl class="stats">
              <dt>Simulated time</dt><dd>{ev.procedure.simSeconds.toFixed(1)} s</dd>
              <dt>Wall time</dt><dd>{ev.procedure.wallMinutes.toFixed(1)} min</dd>
              <dt>Pacing manoeuvres</dt><dd>{ev.procedure.pacingManoeuvres}</dd>
              <dt>Cardioversions</dt><dd>{ev.procedure.cardioversions}</dd>
            </dl>
          </section>
        </div>
        <section>
          <h3>Safety</h3>
          {ev.safety.warnings.length ? <ul class="warnings">{ev.safety.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : <p class="muted small">No safety warnings.</p>}
        </section>
        {gt.truth && <section><h3>What was going on</h3><p class="small">{gt.truth.summary}</p></section>}
        <div class="row"><button onClick={download}>Download report (JSON)</button><button class="primary" onClick={() => (S.reportOpen.value = false)}>Close</button></div>
      </div>
    </div>
  );
}
