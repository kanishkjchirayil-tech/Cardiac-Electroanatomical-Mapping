import { AlievPanfilov, AP_DEFAULT, type ApParams } from './aliev-panfilov';
import { FentonKarma, FK_DEFAULT, type FkParams } from './fenton-karma';
import { MitchellSchaeffer, MS_ATRIAL_DEFAULT, type MsParams } from './mitchell-schaeffer';
import type { IonicModel, IonicModelId } from './types';

export * from './types';
export { MitchellSchaeffer, AlievPanfilov, FentonKarma, MS_ATRIAL_DEFAULT, AP_DEFAULT, FK_DEFAULT };
export type { MsParams, ApParams, FkParams };

export interface IonicSpec {
  id: IonicModelId;
  /** Partial parameter overrides for the chosen model. */
  params?: Partial<MsParams & ApParams & FkParams>;
}

export function createIonicModel(spec: IonicSpec): IonicModel {
  switch (spec.id) {
    case 'ms': return new MitchellSchaeffer({ ...MS_ATRIAL_DEFAULT, ...pick(spec.params, MS_ATRIAL_DEFAULT) });
    case 'ap': return new AlievPanfilov({ ...AP_DEFAULT, ...pick(spec.params, AP_DEFAULT) });
    case 'fk': return new FentonKarma({ ...FK_DEFAULT, ...pick(spec.params, FK_DEFAULT) });
  }
}

function pick<T extends object>(src: object | undefined, keysFrom: T): Partial<T> {
  const out: Partial<T> = {};
  if (!src) return out;
  for (const k of Object.keys(keysFrom) as Array<keyof T>) {
    const val = (src as Record<string, unknown>)[k as string];
    if (typeof val === 'number') out[k] = val as T[keyof T];
  }
  return out;
}
