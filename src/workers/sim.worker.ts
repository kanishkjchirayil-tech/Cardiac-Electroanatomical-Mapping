/// <reference lib="webworker" />
import { SimEngine } from '../engine/engine';
import type { FromWorker, ToWorker } from '../engine/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const engine = new SimEngine((msg: FromWorker, transfer?: Transferable[]) => ctx.postMessage(msg, transfer ?? []));

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': void engine.init(m.mesh, m.config); break;
    case 'configure': void engine.configure(m.config); break;
    case 'play': engine.play(); break;
    case 'pause': engine.pause(); break;
    case 'step': void engine.step(m.ms); break;
    case 'reset': void engine.reset(); break;
    case 'setSpeed': engine.setSpeed(m.speed); break;
    case 'requestActivation': void engine.requestActivation(); break;
    case 'runLab': void engine.runLab(); break;
    case 'placeRoving': void engine.placeRoving(m.vertex); break;
    case 'rovingConfig': void engine.setRovingConfig(m.config); break;
    case 'signals': void engine.setSignals(m.settings); break;
    case 'motion': void engine.setMotion(m.enabled); break;
    case 'setReference': void engine.setReference(m.name); break;
    case 'ablationSettings': engine.setAblationSettings(m.settings); break;
    case 'rfStart': void engine.rfStart(m.instant); break;
    case 'rfStop': void engine.rfStop(); break;
    case 'resetLesions': void engine.resetLesions(); break;
    case 'pace': void engine.pace(m.request); break;
    case 'paceStop': void engine.paceStop(); break;
    case 'cardiovert': void engine.cardiovert(); break;
    case 'requestReport': void engine.requestReport(); break;
    case 'autonomic': void engine.setAutonomic(m.settings); break;
    case 'requestLabels': void engine.requestLabels(); break;
  }
};
