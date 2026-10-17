import { ACT_THRESHOLD } from './backend';
import { ApTemplate } from './eikonal';
import type { IonicModel } from './ionic';

/** Build an AP template by stimulating a single cell (0-D) with the given model. */
export function makeApTemplate(model: IonicModel, apdScale = 1, duration = 600, dt = 0.02, step = 0.5): ApTemplate {
  const [v0, a0, b0] = model.restState();
  const v = Float32Array.of(v0), g0 = Float32Array.of(a0), g1 = Float32Array.of(b0);
  const apd = Float32Array.of(apdScale), exc = Uint8Array.of(1);
  const samples: number[] = [];
  let upstroke = NaN;
  let prev = v0;
  const every = Math.round(step / dt);
  for (let k = 0; k * dt < duration; k++) {
    const t = k * dt;
    if (t < 1) v[0] = v[0]! + dt * 0.5;
    model.react(v, g0, g1, 1, dt, apd, exc);
    if (Number.isNaN(upstroke) && prev < ACT_THRESHOLD && v[0]! >= ACT_THRESHOLD) upstroke = t;
    prev = v[0]!;
    if (k % every === 0) samples.push(v[0]!);
  }
  return new ApTemplate(Float32Array.from(samples), step, Number.isNaN(upstroke) ? 0 : upstroke);
}
