import type { SurfaceMesh } from '../core/mesh/types';
import { PRESETS } from '../core/ep/tissue';
import type { FromWorker, RovingFrame, SimConfig, ToWorker } from '../engine/protocol';
import * as S from './state';
import { EgmStore } from './egm-store';
import type { RovingConfig } from '../core/catheter/roving';
import type { SignalSettings } from '../core/signals/recording';
import { EGM_FS } from '../core/signals/rig';
import * as M from './mapping-state';

/** Recorded channels (main thread), filled from worker frames. */
export const egmStore = new EgmStore(0, EGM_FS);

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
        S.rigInfo.value = m.rig;
        egmStore.reset(m.rig.channels.length, 0);
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
        if (m.egm) {
          egmStore.append(m.egm);
          S.egmVersion.value++;
        }
        // Only publish a new pose when it changed, so the 3D view redraws only when needed.
        if (m.roving && !samePose(m.roving, S.roving.peek())) {
          S.roving.value = m.roving;
          if (M.anatomyBuild.peek()) M.reveal(m.roving.electrodes);
        }
        break;
      case 'activation':
        S.gtActivation.value = { last: m.last, beatStart: m.beatStart, fibrotic: m.fibrotic, t: m.t };
        break;
      case 'beat':
        M.onBeat(m.beat);
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
  send({ type: 'rovingConfig', config: S.rovingConfig.peek() });
  send({ type: 'signals', settings: S.signalSettings.peek() });
  send({ type: 'motion', enabled: S.motionEnabled.peek() });
  send({ type: 'setReference', name: S.referenceChannel.peek() });
  M.initMapping(mesh);
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

export const placeRoving = (vertex: number) => send({ type: 'placeRoving', vertex });
export const setRovingConfig = (patch: Partial<RovingConfig>) => {
  S.rovingConfig.value = { ...S.rovingConfig.peek(), ...patch };
  send({ type: 'rovingConfig', config: patch });
};
export const setSignals = (settings: SignalSettings) => {
  S.signalSettings.value = settings;
  send({ type: 'signals', settings });
};
export const setMotion = (enabled: boolean) => {
  S.motionEnabled.value = enabled;
  send({ type: 'motion', enabled });
};

function samePose(a: RovingFrame, b: RovingFrame | null): boolean {
  if (!b || a.vertex !== b.vertex || a.config !== b.config && JSON.stringify(a.config) !== JSON.stringify(b.config)) return false;
  for (let i = 0; i < a.electrodes.length; i++) if (Math.abs(a.electrodes[i]! - b.electrodes[i]!) > 1e-3) return false;
  return Math.abs(a.force - b.force) < 0.05 && a.stability.stable === b.stability.stable && Math.abs(a.stability.forceMean - b.stability.forceMean) < 0.05;
}

export const setReference = (name: string) => {
  S.referenceChannel.value = name;
  send({ type: 'setReference', name });
};
