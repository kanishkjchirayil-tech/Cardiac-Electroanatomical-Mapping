import type { Vec3 } from '../math/vec3';

/**
 * Body-surface electrodes for an approximate P-wave (MODEL.md §3.4). Positions are in the LPS
 * frame relative to the LA body centre, chosen to give the usual limb-lead geometry (arms
 * superior-lateral, left leg inferior) and a right-parasternal V1. The torso is an infinite
 * homogeneous conductor (σ_torso = 0.2 S/m) with an explicit gain (see TORSO_GAIN).
 */
export const ECG_ELECTRODES: Record<'RA' | 'LA' | 'LL' | 'V1', Vec3> = {
  RA: [-260, -60, 220],
  LA: [260, -60, 220],
  LL: [90, -60, -420],
  V1: [-35, -150, 10],
};

export const K_TORSO = 0.17 / (4 * Math.PI * 0.2);

/**
 * Lumped gain for what the infinite-medium model leaves out: the right atrium (which produces the
 * first half of the real P wave) and torso boundary/inhomogeneity effects. Chosen so the LA
 * component of lead II is ~0.05–0.15 mV; an educational calibration, not a fitted forward model.
 */
export const TORSO_GAIN = 2.5;

export type EcgLead = 'I' | 'II' | 'V1';
