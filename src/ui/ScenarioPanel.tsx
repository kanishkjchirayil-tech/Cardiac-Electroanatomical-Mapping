import { SCENARIO_IDS, scenarioInfo, type ScenarioId } from '../core/scenarios/scenarios';
import * as C from './sim-client';
import * as S from './state';

/** Case selection, briefing and case controls (cardioversion, end of case). */
export function ScenarioPanel() {
  const cur = S.scenario.value;
  const choice = S.scenarioChoice.value;
  const seed = S.scenarioSeed.value;
  const preview = choice === 'free' ? null : scenarioInfo(choice);
  const rd = S.simInfo.value && S.simInfo.value.backend !== 'eikonal';
  return (
    <section class="panel">
      <h2>Case</h2>
      <div class="row">
        <label>Scenario
          <select id="case-select" value={choice} onChange={(e) => (S.scenarioChoice.value = e.currentTarget.value as ScenarioId | 'free')}>
            <option value="free">Free simulation</option>
            {SCENARIO_IDS.map((id) => <option key={id} value={id}>{scenarioInfo(id).name}</option>)}
          </select>
        </label>
        <label>Case seed
          <input id="case-seed" type="number" min={1} value={seed} onInput={(e) => (S.scenarioSeed.value = Math.max(1, Number(e.currentTarget.value) | 0))} />
        </label>
      </div>
      <div class="row">
        <button id="case-start" class="primary" onClick={() => C.startCase(choice, seed)}>{choice === 'free' ? 'Free simulation' : cur && cur.id === choice ? 'Restart case' : 'Start case'}</button>
        <button title="New random seed" onClick={() => (S.scenarioSeed.value = 1 + Math.floor(Math.random() * 9999))}>Random seed</button>
      </div>
      {preview && (!cur || cur.id !== preview.id) && <p class="muted small">{preview.presentation}{preview.requiresRd ? ' Runs on the reaction–diffusion engine.' : ''}</p>}
      {cur && (
        <div class="case-brief">
          <p class="small"><strong>{cur.name}</strong> — {cur.presentation}</p>
          <p class="small"><strong>Goal:</strong> {cur.goal}</p>
          <p class="small muted">Success criteria:</p>
          <ol class="small criteria">{cur.criteria.map((c) => <li key={c}>{c}</li>)}</ol>
          <p class="muted small">Press Run in the Simulation panel to start the case. The arrhythmia, if any, starts on its own.</p>
          <div class="row">
            <button id="cardiovert" disabled={!rd} onClick={C.cardiovert} title="Synchronised DC shock: resets all tissue to rest">Cardiovert</button>
            <button id="end-case" class="primary" onClick={C.requestReport}>End case · report</button>
          </div>
        </div>
      )}
    </section>
  );
}
