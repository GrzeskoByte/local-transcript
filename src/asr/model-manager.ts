import { db } from '../storage/database';
import type { NativeAsrStatus, NativeModelInfo, NativeGpuInfo } from './native-types';

export type ModelState =
  | 'not_installed'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'loaded'
  | 'ready'
  | 'failed';

/**
 * Desktop (native) path. The app shells out to whisper.cpp / voxtype, so the
 * pickable models and language codes are that CLI's. large-v3-turbo is
 * Omarchy/voxtype's max-accuracy Whisper model; Parakeet is the best-accuracy
 * engine overall.
 */
export const NATIVE_DEFAULT_MODEL = 'large-v3-turbo';
export const NATIVE_RECOMMENDED_MODEL = 'large-v3-turbo';
export const MODEL_META_KEY_DESKTOP = 'asr-model-meta-desktop';
const NATIVE_LANGUAGE_KEY = 'asr-language-desktop';

/**
 * Native whisper.cpp DOES detect language, so an explicit 'auto' is honest here.
 */
export const NATIVE_LANGUAGE_OPTIONS = [
  { id: 'auto', label: 'auto · detect' },
  { id: 'en', label: 'en · English' },
  { id: 'de', label: 'de · German' },
  { id: 'fr', label: 'fr · French' },
  { id: 'es', label: 'es · Spanish' },
];

export const DEFAULT_NATIVE_LANGUAGE = 'auto';

/** Prefer an installed model, then the highest-accuracy installed one. */
export function pickDefaultNativeModel(models: NativeModelInfo[]): string {
  const installed = models.filter((m) => m.installed);
  const recommendedInstalled = installed.find((m) => m.recommended);
  if (recommendedInstalled) return recommendedInstalled.name;
  if (installed.length > 0) {
    return installed.reduce((a, b) => (b.accuracy > a.accuracy ? b : a)).name;
  }
  return NATIVE_DEFAULT_MODEL;
}

export function nativeModelLabel(m: NativeModelInfo): string {
  const parts = [m.name];
  if (m.recommended) parts.push('★ best');
  parts.push(m.installed ? 'installed' : 'not installed');
  if (m.detail) parts.push(m.detail);
  return parts.join(' · ');
}

/** Desktop nudge toward the top-accuracy models. */
export function nativeAccuracyHint(
  model: string,
  opts?: { parakeet?: boolean },
): string | null {
  const top = /^(large-v3|large-v3-turbo)$/i.test(model) || /^parakeet/i.test(model);
  if (top) return null;
  const alt = opts?.parakeet === false ? '' : ' or parakeet-tdt-0.6b-v3';
  return `For maximum accuracy on desktop, switch to large-v3-turbo (Whisper)${alt}.`;
}

/** Human-readable desktop engine/runtime line for the UI. */
export function describeNativeRuntime(status: NativeAsrStatus | null): string {
  if (!status) return 'Detecting the desktop transcription engine…';
  if (!status.available) {
    return (
      status.installHint ??
      'No desktop transcription engine found. Install whisper.cpp (whisper-cli) or voxtype.'
    );
  }
  const ver = status.version ? ` ${status.version}` : '';
  const accel = status.acceleration ? ` · ${status.acceleration}` : '';
  return `Desktop engine: ${status.backend}${ver}${accel} — native models on disk.`;
}

/** Human-readable GPU acceleration line for Settings. */
export function describeGpu(gpu: NativeGpuInfo | null | undefined): string {
  if (!gpu) return 'GPU status unavailable.';
  const name = gpu.backend ? ` (${gpu.backend})` : '';
  if (gpu.active) return `GPU acceleration is active${name}.`;
  if (gpu.available) {
    return `A GPU backend is available${name} — enable it to transcribe faster and unlock GPU-only models.`;
  }
  if (gpu.devices.length > 0) {
    return `GPU detected (${gpu.devices[0]}) but no acceleration backend is installed.`;
  }
  return 'No GPU detected — transcription runs on the CPU.';
}

export async function getTranscriptionLanguage(): Promise<string> {
  const native = await db.kvGet<string>(NATIVE_LANGUAGE_KEY);
  return NATIVE_LANGUAGE_OPTIONS.some((l) => l.id === native)
    ? (native as string)
    : DEFAULT_NATIVE_LANGUAGE;
}

export async function setTranscriptionLanguage(id: string): Promise<void> {
  const valid = NATIVE_LANGUAGE_OPTIONS.some((l) => l.id === id) ? id : DEFAULT_NATIVE_LANGUAGE;
  await db.kvSet(NATIVE_LANGUAGE_KEY, valid);
}

export interface ModelMeta {
  modelId: string;
  state: ModelState;
  progress: number;
  /** Byte size observed at verify time (integrity gate). */
  bytes?: number;
  sha256?: string;
  error?: string;
  updatedAt: number;
}

export async function getModelMeta(): Promise<ModelMeta> {
  const meta = await db.kvGet<ModelMeta>(MODEL_META_KEY_DESKTOP);
  if (meta && !meta.modelId) {
    // Model list changed since install — fall back to the default.
    return {
      modelId: NATIVE_DEFAULT_MODEL,
      state: 'not_installed',
      progress: 0,
      updatedAt: Date.now(),
    };
  }
  return (
    meta ?? {
      modelId: NATIVE_DEFAULT_MODEL,
      state: 'not_installed',
      progress: 0,
      updatedAt: Date.now(),
    }
  );
}

export async function setModelMeta(meta: ModelMeta): Promise<void> {
  await db.kvSet(MODEL_META_KEY_DESKTOP, { ...meta, updatedAt: Date.now() });
}
