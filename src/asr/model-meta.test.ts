import { describe, expect, it } from 'vitest';
import { modelChipLabel, reconcileModelMeta, type ModelMeta } from './model-manager';

const meta = (over: Partial<ModelMeta>): ModelMeta => ({
  modelId: 'large-v3-turbo',
  state: 'not_installed',
  progress: 0,
  updatedAt: 0,
  ...over,
});

describe('reconcileModelMeta', () => {
  const installed = [
    { id: 'base.en', accuracy: 2 },
    { id: 'large-v3-turbo-q5_0', accuracy: 4 },
  ];

  it('marks the selected model ready when it is on disk', () => {
    const out = reconcileModelMeta(meta({ modelId: 'base.en' }), installed);
    expect(out).toMatchObject({ modelId: 'base.en', state: 'ready', progress: 1 });
  });

  it('switches a missing selection to the best installed model', () => {
    const out = reconcileModelMeta(meta({ modelId: 'large-v3-turbo' }), installed);
    expect(out).toMatchObject({ modelId: 'large-v3-turbo-q5_0', state: 'ready' });
  });

  it('prefers the recommended installed model', () => {
    const out = reconcileModelMeta(meta({}), [...installed, { id: 'small', accuracy: 1, recommended: true }]);
    expect(out?.modelId).toBe('small');
  });

  it('is a no-op when already consistent', () => {
    expect(reconcileModelMeta(meta({ modelId: 'base.en', state: 'ready' }), installed)).toBeNull();
    expect(reconcileModelMeta(meta({}), [])).toBeNull();
  });

  it('drops a stale ready when nothing is installed', () => {
    expect(reconcileModelMeta(meta({ state: 'ready' }), [])?.state).toBe('not_installed');
  });

  it('never interrupts a download', () => {
    expect(reconcileModelMeta(meta({ state: 'downloading' }), installed)).toBeNull();
  });
});

describe('modelChipLabel', () => {
  it('names the ready model', () => {
    expect(modelChipLabel(meta({ modelId: 'base.en', state: 'ready' }))).toBe('Model: base.en');
  });
  it('shows download progress', () => {
    expect(modelChipLabel(meta({ state: 'downloading', progress: 0.42 }))).toBe('Downloading large-v3-turbo · 42%');
  });
  it('explains a missing model', () => {
    expect(modelChipLabel(meta({}))).toBe('No speech model yet');
  });
});
