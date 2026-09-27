import { describe, expect, it } from 'vitest';
import { TIERS, groupByTier, nativeCatalog, tierForAccuracy } from './model-tiers';
import type { NativeModelInfo } from './native-types';

function nativeModel(over: Partial<NativeModelInfo> & { name: string }): NativeModelInfo {
  return {
    engine: 'whisper',
    installed: false,
    downloadable: true,
    path: null,
    sizeBytes: null,
    accuracy: 2,
    recommended: false,
    detail: '',
    ...over,
  };
}

describe('tierForAccuracy', () => {
  it('maps ranks to S/A/B/C/D', () => {
    expect(tierForAccuracy(6)).toBe('S');
    expect(tierForAccuracy(5)).toBe('S');
    expect(tierForAccuracy(4)).toBe('A');
    expect(tierForAccuracy(3)).toBe('B');
    expect(tierForAccuracy(2)).toBe('C');
    expect(tierForAccuracy(1)).toBe('D');
  });

  it('has a blurb for every tier id used', () => {
    const ids = TIERS.map((t) => t.id);
    expect(ids).toEqual(['S', 'A', 'B', 'C', 'D']);
    for (const tier of TIERS) expect(tier.blurb.length).toBeGreaterThan(0);
  });
});

describe('nativeCatalog + groupByTier', () => {
  const native = [
    nativeModel({ name: 'parakeet-tdt-0.6b-v3', engine: 'parakeet', accuracy: 6, recommended: true }),
    nativeModel({ name: 'large-v3-turbo', accuracy: 5, recommended: true, installed: true }),
    nativeModel({ name: 'medium', accuracy: 4 }),
    nativeModel({ name: 'small', accuracy: 3 }),
    nativeModel({ name: 'base.en', accuracy: 2, installed: true }),
    nativeModel({ name: 'tiny.en', accuracy: 1 }),
  ];

  it('assigns each native model a tier from its engine/accuracy', () => {
    const catalog = nativeCatalog(native);
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m.tier]));
    expect(byId['parakeet-tdt-0.6b-v3']).toBe('S');
    expect(byId['large-v3-turbo']).toBe('S');
    expect(byId['medium']).toBe('A');
    expect(byId['small']).toBe('B');
    expect(byId['base.en']).toBe('C');
    expect(byId['tiny.en']).toBe('D');
  });

  it('groups best-tier first and installed models first within a tier', () => {
    const groups = groupByTier(nativeCatalog(native));
    expect(groups.map((g) => g.tier.id)).toEqual(['S', 'A', 'B', 'C', 'D']);
    const top = groups[0]!;
    expect(top.models[0]!.id).toBe('large-v3-turbo'); // installed beats not-installed at equal tier
    expect(top.models.map((m) => m.id)).toContain('parakeet-tdt-0.6b-v3');
  });

  it('omits empty tiers', () => {
    const groups = groupByTier(nativeCatalog([nativeModel({ name: 'small', accuracy: 3 })]));
    expect(groups.map((g) => g.tier.id)).toEqual(['B']);
  });
});
