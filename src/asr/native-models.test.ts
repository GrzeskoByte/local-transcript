import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NATIVE_LANGUAGE,
  NATIVE_DEFAULT_MODEL,
  NATIVE_LANGUAGE_OPTIONS,
  describeGpu,
  describeNativeRuntime,
  nativeAccuracyHint,
  nativeModelLabel,
  pickDefaultNativeModel,
} from './model-manager';
import type { NativeAsrStatus, NativeModelInfo } from './native-types';

function model(over: Partial<NativeModelInfo> & { name: string }): NativeModelInfo {
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

const STATUS: NativeAsrStatus = {
  available: true,
  backend: 'voxtype',
  binaryPath: '/usr/bin/voxtype',
  version: 'voxtype 1.0.1',
  engines: ['whisper', 'parakeet'],
  acceleration: 'State: cpu-only',
  gpu: { available: false, active: false, backend: null, devices: [], hint: null },
  modelDir: '/home/me/.local/share/voxtype/models',
  models: [],
  installHint: null,
};

describe('native language options', () => {
  it('offers honest auto-detection (native whisper.cpp can detect)', () => {
    expect(NATIVE_LANGUAGE_OPTIONS.some((l) => l.id === 'auto')).toBe(true);
    expect(DEFAULT_NATIVE_LANGUAGE).toBe('auto');
  });
});

describe('pickDefaultNativeModel', () => {
  it('prefers the recommended model when it is installed', () => {
    expect(
      pickDefaultNativeModel([
        model({ name: 'small.en', installed: true, accuracy: 3 }),
        model({ name: 'large-v3-turbo', installed: true, accuracy: 5, recommended: true }),
      ]),
    ).toBe('large-v3-turbo');
  });

  it('falls back to the highest-accuracy installed model', () => {
    expect(
      pickDefaultNativeModel([
        model({ name: 'base.en', installed: true, accuracy: 2 }),
        model({ name: 'small.en', installed: true, accuracy: 3 }),
      ]),
    ).toBe('small.en');
  });

  it('falls back to the recommended default when nothing is installed', () => {
    expect(pickDefaultNativeModel([model({ name: 'tiny.en', accuracy: 1 })])).toBe(
      NATIVE_DEFAULT_MODEL,
    );
    expect(pickDefaultNativeModel([])).toBe('large-v3-turbo');
  });
});

describe('nativeAccuracyHint', () => {
  it('nudges small models toward the top-accuracy options', () => {
    expect(nativeAccuracyHint('base.en')).toMatch(/large-v3-turbo/);
    expect(nativeAccuracyHint('small')).toMatch(/parakeet/);
  });

  it('omits Parakeet when the build cannot run that engine', () => {
    const hint = nativeAccuracyHint('base.en', { parakeet: false });
    expect(hint).toMatch(/large-v3-turbo/);
    expect(hint).not.toMatch(/parakeet/);
  });

  it('stays silent for the top engines', () => {
    expect(nativeAccuracyHint('large-v3-turbo')).toBeNull();
    expect(nativeAccuracyHint('large-v3')).toBeNull();
    expect(nativeAccuracyHint('parakeet-tdt-0.6b-v3')).toBeNull();
  });
});

describe('describeNativeRuntime', () => {
  it('reports the backend, version and acceleration', () => {
    const text = describeNativeRuntime(STATUS);
    expect(text).toMatch(/voxtype 1\.0\.1/);
    expect(text).toMatch(/cpu-only/);
  });

  it('surfaces the install hint when no engine is present', () => {
    const none: NativeAsrStatus = {
      ...STATUS,
      available: false,
      backend: 'none',
      installHint: 'Install whisper.cpp or voxtype.',
    };
    expect(describeNativeRuntime(none)).toBe('Install whisper.cpp or voxtype.');
  });

  it('explains detection is still in progress before the probe resolves', () => {
    expect(describeNativeRuntime(null)).toMatch(/Detecting/);
  });
});

describe('nativeModelLabel', () => {
  it('marks recommended and install state', () => {
    const label = nativeModelLabel(
      model({ name: 'large-v3-turbo', recommended: true, installed: true, detail: '~1.6 GB · multilingual' }),
    );
    expect(label).toContain('large-v3-turbo');
    expect(label).toContain('★ best');
    expect(label).toContain('installed');
    expect(label).toContain('multilingual');
  });
});

describe('describeGpu', () => {
  it('reports active acceleration with the backend name', () => {
    expect(
      describeGpu({ available: true, active: true, backend: 'Vulkan', devices: [], hint: null }),
    ).toMatch(/active \(Vulkan\)/);
  });

  it('invites the user to enable an available GPU', () => {
    const text = describeGpu({
      available: true,
      active: false,
      backend: 'Vulkan',
      devices: ['1. [Intel] Tiger Lake-LP GT2'],
      hint: 'sudo voxtype setup gpu --enable',
    });
    expect(text).toMatch(/available \(Vulkan\)/);
    expect(text).toMatch(/enable/i);
  });

  it('explains a detected-but-unusable GPU and the no-GPU case', () => {
    expect(
      describeGpu({ available: false, active: false, backend: null, devices: ['1. [Intel] X'], hint: null }),
    ).toMatch(/no acceleration backend/);
    expect(
      describeGpu({ available: false, active: false, backend: null, devices: [], hint: null }),
    ).toMatch(/runs on the CPU/);
    expect(describeGpu(null)).toMatch(/unavailable/);
  });
});
