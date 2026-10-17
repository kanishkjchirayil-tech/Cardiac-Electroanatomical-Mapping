import { normalize, type Vec3 } from '../core/math/vec3';

/**
 * Standard fluoroscopy-style camera views in the LPS patient frame
 * (+x patient left, +y posterior, +z superior). `dir` points from the heart towards the
 * camera; `up` is the screen-up direction.
 */
export type ViewName = 'AP' | 'PA' | 'LAO' | 'RAO' | 'LL' | 'RL' | 'SUP' | 'INF';

export interface ViewDef {
  name: ViewName;
  label: string;
  dir: Vec3;
  up: Vec3;
}

export function standardViews(obliqueDeg = 30): ViewDef[] {
  const a = (obliqueDeg * Math.PI) / 180;
  return [
    { name: 'AP', label: 'AP', dir: [0, -1, 0], up: [0, 0, 1] },
    { name: 'PA', label: 'PA', dir: [0, 1, 0], up: [0, 0, 1] },
    { name: 'LAO', label: `LAO ${obliqueDeg}°`, dir: normalize([Math.sin(a), -Math.cos(a), 0]), up: [0, 0, 1] },
    { name: 'RAO', label: `RAO ${obliqueDeg}°`, dir: normalize([-Math.sin(a), -Math.cos(a), 0]), up: [0, 0, 1] },
    { name: 'LL', label: 'Left lateral', dir: [1, 0, 0], up: [0, 0, 1] },
    { name: 'RL', label: 'Right lateral', dir: [-1, 0, 0], up: [0, 0, 1] },
    { name: 'SUP', label: 'Superior', dir: [0, 0, 1], up: [0, -1, 0] },
    { name: 'INF', label: 'Inferior', dir: [0, 0, -1], up: [0, -1, 0] },
  ];
}
