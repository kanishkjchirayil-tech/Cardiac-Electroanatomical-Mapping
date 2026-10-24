/**
 * Anatomical segment labels stored per vertex. Numeric values are part of the
 * export format (sidecar JSON, datasets) — append new labels, never renumber.
 */
export enum Region {
  Unlabeled = 0,
  Anterior = 1,
  Roof = 2,
  Posterior = 3,
  Inferior = 4,
  Septum = 5,
  Lateral = 6,
  LSPV = 7,
  LIPV = 8,
  RSPV = 9,
  RIPV = 10,
  LSPVAntrum = 11,
  LIPVAntrum = 12,
  RSPVAntrum = 13,
  RIPVAntrum = 14,
  LAA = 15,
  MitralAnnulus = 16,
  MitralIsthmus = 17,
  // Right atrium (stretch goal; MODEL.md §8).
  RAFreeWall = 18,
  RAPosterior = 19,
  RASeptum = 20,
  CristaTerminalis = 21,
  CTI = 22,
  SVC = 23,
  IVC = 24,
  RAA = 25,
  TricuspidAnnulus = 26,
  CSOstium = 27,
}

export const REGION_COUNT = 28;

export interface RegionInfo {
  id: Region;
  key: string;
  name: string;
  /** sRGB display colour for the region overlay. */
  color: [number, number, number];
  /** Default wall thickness (mm); see MODEL.md §1.4 for sources. */
  thickness: number;
}

export const REGIONS: readonly RegionInfo[] = [
  { id: Region.Unlabeled, key: 'unlabeled', name: 'Unlabeled', color: [0.55, 0.55, 0.55], thickness: 1.8 },
  { id: Region.Anterior, key: 'anterior', name: 'Anterior wall', color: [0.91, 0.62, 0.45], thickness: 2.0 },
  { id: Region.Roof, key: 'roof', name: 'Roof', color: [0.95, 0.83, 0.42], thickness: 1.8 },
  { id: Region.Posterior, key: 'posterior', name: 'Posterior wall', color: [0.55, 0.78, 0.55], thickness: 1.5 },
  { id: Region.Inferior, key: 'inferior', name: 'Inferior wall (floor)', color: [0.48, 0.68, 0.86], thickness: 1.8 },
  { id: Region.Septum, key: 'septum', name: 'Septum', color: [0.74, 0.58, 0.86], thickness: 2.0 },
  { id: Region.Lateral, key: 'lateral', name: 'Lateral wall', color: [0.86, 0.72, 0.62], thickness: 1.9 },
  { id: Region.LSPV, key: 'lspv', name: 'LSPV', color: [0.84, 0.19, 0.25], thickness: 1.0 },
  { id: Region.LIPV, key: 'lipv', name: 'LIPV', color: [0.93, 0.42, 0.13], thickness: 1.0 },
  { id: Region.RSPV, key: 'rspv', name: 'RSPV', color: [0.15, 0.45, 0.80], thickness: 1.0 },
  { id: Region.RIPV, key: 'ripv', name: 'RIPV', color: [0.10, 0.62, 0.62], thickness: 1.0 },
  { id: Region.LSPVAntrum, key: 'lspv_antrum', name: 'LSPV antrum', color: [0.95, 0.55, 0.58], thickness: 1.6 },
  { id: Region.LIPVAntrum, key: 'lipv_antrum', name: 'LIPV antrum', color: [0.98, 0.70, 0.48], thickness: 1.6 },
  { id: Region.RSPVAntrum, key: 'rspv_antrum', name: 'RSPV antrum', color: [0.55, 0.72, 0.95], thickness: 1.6 },
  { id: Region.RIPVAntrum, key: 'ripv_antrum', name: 'RIPV antrum', color: [0.52, 0.85, 0.82], thickness: 1.6 },
  { id: Region.LAA, key: 'laa', name: 'LA appendage', color: [0.60, 0.40, 0.25], thickness: 1.2 },
  { id: Region.MitralAnnulus, key: 'mitral_annulus', name: 'Mitral annulus', color: [0.42, 0.42, 0.50], thickness: 2.6 },
  { id: Region.MitralIsthmus, key: 'mitral_isthmus', name: 'Mitral isthmus', color: [0.80, 0.30, 0.65], thickness: 2.4 },
  { id: Region.RAFreeWall, key: 'ra_free_wall', name: 'RA free wall (trabeculated)', color: [0.86, 0.66, 0.56], thickness: 2.0 },
  { id: Region.RAPosterior, key: 'ra_posterior', name: 'RA posterior (venous sinus)', color: [0.60, 0.78, 0.58], thickness: 2.0 },
  { id: Region.RASeptum, key: 'ra_septum', name: 'RA septum', color: [0.74, 0.58, 0.86], thickness: 2.2 },
  { id: Region.CristaTerminalis, key: 'crista_terminalis', name: 'Crista terminalis', color: [0.95, 0.78, 0.30], thickness: 4.5 },
  { id: Region.CTI, key: 'cti', name: 'Cavotricuspid isthmus', color: [0.85, 0.28, 0.62], thickness: 3.5 },
  { id: Region.SVC, key: 'svc', name: 'SVC', color: [0.18, 0.46, 0.80], thickness: 1.2 },
  { id: Region.IVC, key: 'ivc', name: 'IVC', color: [0.12, 0.60, 0.62], thickness: 1.2 },
  { id: Region.RAA, key: 'raa', name: 'RA appendage', color: [0.62, 0.42, 0.26], thickness: 1.6 },
  { id: Region.TricuspidAnnulus, key: 'tricuspid_annulus', name: 'Tricuspid annulus', color: [0.42, 0.42, 0.50], thickness: 3.0 },
  { id: Region.CSOstium, key: 'cs_ostium', name: 'CS ostium', color: [0.92, 0.50, 0.20], thickness: 2.0 },
];

export const PV_REGIONS = [Region.LSPV, Region.LIPV, Region.RSPV, Region.RIPV] as const;
export const PV_ANTRUM_REGIONS = [Region.LSPVAntrum, Region.LIPVAntrum, Region.RSPVAntrum, Region.RIPVAntrum] as const;
export const PV_NAMES = ['LSPV', 'LIPV', 'RSPV', 'RIPV'] as const;
export type PvName = (typeof PV_NAMES)[number];

export function regionByKey(key: string): Region | undefined {
  const k = key.toLowerCase();
  return REGIONS.find((r) => r.key === k || r.name.toLowerCase() === k)?.id;
}
