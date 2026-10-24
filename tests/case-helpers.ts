import { SimEngine } from '../src/engine/engine';
import { DEFAULT_SIM_CONFIG, type FromWorker, type PacingStatus } from '../src/engine/protocol';
import type { ScenarioId } from '../src/core/scenarios/scenarios';
import { MeshTools } from '../src/core/scenarios/geometry';
import type { PacingRequest } from '../src/core/pacing/protocols';
import { DEFAULT_ABLATION } from '../src/core/ablation/controller';
import { defaultAtrium } from './helpers';

/** A reaction–diffusion case on the CPU backend, driven like the UI would. */
export async function startCase(id: ScenarioId, seed: number) {
  const { mesh } = defaultAtrium();
  const msgs: FromWorker[] = [];
  const engine = new SimEngine((m) => msgs.push(m));
  await engine.init(mesh, { ...DEFAULT_SIM_CONFIG, mode: 'rd', backend: 'cpu', scenario: { id, seed } });
  const tools = new MeshTools(mesh);
  const refCls: number[] = [];
  const last = <T extends FromWorker['type']>(type: T) => [...msgs].reverse().find((m) => m.type === type) as Extract<FromWorker, { type: T }> | undefined;
  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      await engine.step(250);
      for (const m of msgs) if (m.type === 'beat') refCls.push(m.beat.cl);
      // Keep only the newest messages of each kind we read later.
      const keep = msgs.filter((m) => m.type === 'pacing' || m.type === 'report' || m.type === 'lesions' || m.type === 'ready' || m.type === 'error');
      msgs.length = 0;
      msgs.push(...keep.slice(-40));
    }
  };
  const burn = async (vertices: number[], power = DEFAULT_ABLATION.power, duration = DEFAULT_ABLATION.duration) => {
    engine.setAblationSettings({ ...DEFAULT_ABLATION, power, duration });
    for (const v of vertices) {
      await engine.placeRoving(v);
      await engine.rfStart(true);
    }
  };
  const pace = async (req: PacingRequest, ms: number): Promise<PacingStatus> => {
    await engine.pace(req);
    await run(ms);
    return [...msgs].reverse().find((m) => m.type === 'pacing' && m.status)!.type === 'pacing' ? ([...msgs].reverse().find((m) => m.type === 'pacing' && m.status) as { status: PacingStatus }).status : (null as never);
  };
  const report = async () => {
    await engine.requestReport();
    return last('report')!.report;
  };
  const error = () => last('error')?.message;
  /** Ground-truth lesion raster (0 none, 1 partial/border, 2 core), for placing catheters off scar. */
  const lesionKind = () => last('lesions')?.kind ?? new Uint8Array(mesh.region.length);
  return { mesh, engine, tools, run, burn, pace, report, refCls, error, lesionKind };
}

/** Lesion centres every `spacing` mm along a vertex path. */
export function along(tools: MeshTools, path: number[], spacing = 4): number[] {
  const out = [path[0]!];
  let acc = 0;
  for (let k = 1; k < path.length; k++) {
    acc += tools.distance(path[k - 1]!, path[k]!);
    if (acc >= spacing) { out.push(path[k]!); acc = 0; }
  }
  if (out[out.length - 1] !== path[path.length - 1]) out.push(path[path.length - 1]!);
  return out;
}

export const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1]! : NaN;
};
