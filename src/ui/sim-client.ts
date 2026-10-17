import type { SurfaceMesh } from '../core/mesh/types';
import { PRESETS } from '../core/ep/tissue';
import type { FromWorker, SimConfig, ToWorker } from '../engine/protocol';
import * as S from './state';

/** Main-thread handle to the simulation worker; mirrors worker messages into UI signals. */
let worker: Worker | null = null;
export let latestVm: Float32Array | null = null;

function send(msg: ToWorker): void {
  worker?.postMessage(msg);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    switch (m.type) {
      case 'status':
        S.simStatus.value = m.message;
        break;
      case 'ready':
        S.simInfo.value = m.info;
        S.simConfig.value = m.config;
        S.simStatus.value = '';
        S.gtActivation.value = null;
        if (S.teacherView.peek() && S.teacherOverlay.peek() !== 'vm') requestActivation();
        break;
      case 'frame':
        latestVm = m.v;
        S.simTime.value = m.t;
        S.simSpeed.value = m.speed;
        S.simRunning.value = m.running;
        S.vmFrameId.value++;
        break;
      case 'activation':
        S.gtActivation.value = { last: m.last, beatStart: m.beatStart, fibrotic: m.fibrotic, t: m.t };
        break;
      case 'lab':
        S.labRunning.value = false;
        S.simStatus.value = '';
        S.labResult.value = { D0: m.D0, cv: m.cv, apd90: m.apd90, restitution: m.restitution, label: `${PRESETS[m.preset].name} · ${m.ionic.toUpperCase()}` };
        break;
      case 'error':
        S.labRunning.value = false;
        S.simStatus.value = '';
        S.errorMsg.value = `Simulation error: ${m.message}`;
        break;
    }
  };
  return worker;
}

export function initSimulation(mesh: SurfaceMesh): void {
  ensureWorker();
  S.simInfo.value = null;
  S.simRunning.value = false;
  latestVm = null;
  send({ type: 'init', mesh, config: S.simConfig.peek() });
  send({ type: 'setSpeed', speed: S.speedTarget.peek() });
}

export function configure(patch: Partial<SimConfig>): void {
  S.simConfig.value = { ...S.simConfig.peek(), ...patch };
  S.simInfo.value = Object.keys(patch).every((k) => k === 'sinusCl') ? S.simInfo.peek() : null;
  send({ type: 'configure', config: patch });
}

export const play = () => send({ type: 'play' });
export const pause = () => send({ type: 'pause' });
export const step = (ms: number) => send({ type: 'step', ms });
export const reset = () => send({ type: 'reset' });
export const setSpeed = (speed: number) => {
  S.speedTarget.value = speed;
  send({ type: 'setSpeed', speed });
};
export const requestActivation = () => send({ type: 'requestActivation' });
export const runLab = () => {
  S.labRunning.value = true;
  send({ type: 'runLab' });
};
