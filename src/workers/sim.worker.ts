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
  }
};
