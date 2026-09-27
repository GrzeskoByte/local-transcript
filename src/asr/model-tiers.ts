import type { NativeModelInfo } from './native-types';

/** Quality tier, derived from each model's accuracy rank. */
export type ModelTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface TierInfo {
  id: ModelTier;
  label: string;
  blurb: string;
}

export const TIERS: TierInfo[] = [
  {
    id: 'S',
    label: 'S · Best accuracy',
    blurb: 'Maximum quality. Largest and slowest — worth it for important meetings.',
  },
  {
    id: 'A',
    label: 'A · Great',
    blurb: 'Near-top accuracy with a much smaller download.',
  },
  {
    id: 'B',
    label: 'B · Balanced',
    blurb: 'Good everyday accuracy and speed.',
  },
  {
    id: 'C',
    label: 'C · Fast',
    blurb: 'Quick drafts; expect noticeably more mistakes.',
  },
  {
    id: 'D',
    label: 'D · Fastest',
    blurb: 'Smallest and quickest, lowest quality — mostly for testing.',
  },
];

/** Map an accuracy rank to a tier. Rank 6 (Parakeet) and 5 (large-v3) are top. */
export function tierForAccuracy(accuracy: number): ModelTier {
  if (accuracy >= 5) return 'S';
  if (accuracy === 4) return 'A';
  if (accuracy === 3) return 'B';
  if (accuracy === 2) return 'C';
  return 'D';
}

/** A native model as presented in the settings catalog. */
export interface CatalogModel {
  /** Native model name, e.g. "large-v3-turbo". */
  id: string;
  /** Display name. */
  label: string;
  engine: string;
  accuracy: number;
  tier: ModelTier;
  installed: boolean;
  downloadable: boolean;
  recommended: boolean;
  detail: string;
}

export function nativeCatalog(models: NativeModelInfo[]): CatalogModel[] {
  return models.map((m) => ({
    id: m.name,
    label: m.name,
    engine: m.engine,
    accuracy: m.accuracy,
    tier: tierForAccuracy(m.accuracy),
    installed: m.installed,
    downloadable: m.downloadable,
    recommended: m.recommended,
    detail: m.detail,
  }));
}

/** Group a catalog into tiers, best first, installed models first inside a tier. */
export function groupByTier(
  models: CatalogModel[],
): { tier: TierInfo; models: CatalogModel[] }[] {
  return TIERS.map((tier) => ({
    tier,
    models: models
      .filter((m) => m.tier === tier.id)
      .sort(
        (a, b) =>
          Number(b.installed) - Number(a.installed) ||
          b.accuracy - a.accuracy ||
          a.label.localeCompare(b.label),
      ),
  })).filter((group) => group.models.length > 0);
}
