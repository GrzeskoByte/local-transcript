/**
 * Shared types for the native (desktop) transcription path. Kept dependency
 * free so both the pure model helpers and the engine can import them without
 * creating a cycle.
 */

/** GPU acceleration state reported by the desktop backend. */
export interface NativeGpuInfo {
  /** A GPU acceleration backend is installed and ready to be switched on. */
  available: boolean;
  /** Acceleration is already the active backend. */
  active: boolean;
  /** "Vulkan" | "CUDA" | "MIGraphX" | ... */
  backend: string | null;
  devices: string[];
  /** Manual enable command, surfaced when automatic enable fails. */
  hint: string | null;
}

/** One transcription engine the desktop backend found (whisper-cli or voxtype). */
export interface NativeAsrStatus {
  available: boolean;
  /** "whisper-cli" | "voxtype" | "none" */
  backend: string;
  binaryPath: string | null;
  version: string | null;
  engines: string[];
  acceleration: string | null;
  gpu: NativeGpuInfo;
  modelDir: string | null;
  models: NativeModelInfo[];
  installHint: string | null;
  /** The whisper.cpp engine shipped inside the app is in use (zero setup). */
  bundled?: boolean;
  /** Model to download on first use for this backend (one-click setup). */
  recommendedModel?: string | null;
}

/** Progress of a model download started through the desktop backend. */
export interface NativeDownloadProgress {
  received: number;
  /** 0 when the size is unknown. */
  total: number;
  done: boolean;
}

/** A model offered by the desktop backend. */
export interface NativeModelInfo {
  /** Native model name, e.g. "large-v3-turbo" (not a Hugging Face repo id). */
  name: string;
  /** "whisper" | "parakeet" | ... */
  engine: string;
  installed: boolean;
  downloadable: boolean;
  path: string | null;
  sizeBytes: number | null;
  accuracy: number;
  recommended: boolean;
  detail: string;
}

/** A timestamped segment returned by the desktop backend. */
export interface NativeSegment {
  startMs: number;
  endMs: number;
  text: string;
}
