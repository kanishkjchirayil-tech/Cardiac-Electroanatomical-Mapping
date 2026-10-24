import { contactCoupling, DEFAULT_LESION_MODEL, lesionQuality, lesionSize, type LesionModelParams } from './lesion';

/**
 * One RF application (MODEL.md §5.2): integrates effective energy, force–time integral, an
 * impedance drop and, inside the esophageal zone, a luminal esophageal temperature estimate.
 *
 *   impedance        Z(t) = Z₀ − ΔZ_max · (1 − exp(−E / E_Z)),  Z₀ = 110 Ω − 0.3 Ω/g · min(F, 30)
 *   esophageal temp  T(t) = 37 + k_T · P·c(F) · exp(−gap / λ) · (1 − exp(−t / τ_T))
 *                    gap = wall thickness + peri-esophageal tissue − current lesion depth (≥ 0)
 * All constants are phenomenological and documented as such.
 */
export interface RfSettings {
  power: number;
  /** Target RF duration, s. */
  duration: number;
}

export interface RfReadout {
  elapsed: number;
  power: number;
  force: number;
  energy: number;
  fti: number;
  impedance: number;
  impedanceDrop: number;
  depth: number;
  diameter: number;
  thickness: number;
  lqi: number;
  /** NaN outside the esophageal zone. */
  esophagealTemp: number;
  done: boolean;
}

export const RF_CONSTANTS = {
  z0: 110,
  z0PerGram: 0.3,
  dzMax: 15,
  energyZ: 350,
  tempGain: 0.11,
  tempLambda: 1.2,
  tempTau: 12,
  periEsophageal: 2.0,
  tempWarning: 39,
};

export class RfApplication {
  elapsed = 0;
  energy = 0;
  fti = 0;
  private forceSum = 0;
  private lastForce = 0;
  private z0 = RF_CONSTANTS.z0;

  constructor(readonly settings: RfSettings, readonly thickness: number, readonly inEsophagealZone: boolean, readonly model: LesionModelParams = DEFAULT_LESION_MODEL) {}

  /** Advance by dt seconds of RF at contact force `force` (g). */
  step(dt: number, force: number): void {
    if (this.elapsed === 0) this.z0 = RF_CONSTANTS.z0 - RF_CONSTANTS.z0PerGram * Math.min(force, 30);
    const d = Math.min(dt, Math.max(0, this.settings.duration - this.elapsed));
    this.energy += this.settings.power * d * contactCoupling(force, this.model);
    this.fti += force * d;
    this.forceSum += force * d;
    this.elapsed += d;
    this.lastForce = force;
  }

  get done(): boolean {
    return this.elapsed >= this.settings.duration - 1e-9;
  }

  get meanForce(): number {
    return this.elapsed > 0 ? this.forceSum / this.elapsed : this.lastForce;
  }

  readout(): RfReadout {
    const { depth, diameter } = lesionSize(this.energy, this.settings.power, this.model);
    const drop = RF_CONSTANTS.dzMax * (1 - Math.exp(-this.energy / RF_CONSTANTS.energyZ));
    let esophagealTemp = NaN;
    if (this.inEsophagealZone) {
      const gap = Math.max(0, this.thickness + RF_CONSTANTS.periEsophageal - depth);
      const drive = this.settings.power * contactCoupling(this.lastForce, this.model);
      esophagealTemp = 37 + RF_CONSTANTS.tempGain * drive * Math.exp(-gap / RF_CONSTANTS.tempLambda) * (1 - Math.exp(-this.elapsed / RF_CONSTANTS.tempTau));
    }
    return {
      elapsed: this.elapsed,
      power: this.settings.power,
      force: this.lastForce,
      energy: this.energy,
      fti: this.fti,
      impedance: this.z0 - drop,
      impedanceDrop: drop,
      depth,
      diameter,
      thickness: this.thickness,
      lqi: lesionQuality(depth, this.thickness),
      esophagealTemp,
      done: this.done,
    };
  }
}
