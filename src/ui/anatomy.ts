import { loadProceduralAtrium } from './mesh-service';
import * as S from './state';

/** Generate (or load from cache) the procedural chamber chosen in the Anatomy panel. */
export async function generate(): Promise<void> {
  S.errorMsg.value = null;
  S.loading.value = { stage: 'starting', fraction: 0 };
  const chamber = S.genChamber.value;
  try {
    const r = await loadProceduralAtrium(
      { seed: S.genSeed.value, variability: S.genVariability.value, chamber },
      (stage, fraction) => (S.loading.value = { stage, fraction }),
    );
    S.importWarnings.value = [];
    S.quality.value = r.quality;
    S.meshSource.value = `Procedural ${chamber} · seed ${S.genSeed.value} · variability ${S.genVariability.value}${r.fromCache ? ' (cached)' : ''}`;
    S.mesh.value = r.mesh;
  } catch (e) {
    S.errorMsg.value = `Mesh generation failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    S.loading.value = null;
  }
}
