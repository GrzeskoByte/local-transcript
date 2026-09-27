export interface AsrRuntimeConfig {
  device: 'webgpu' | 'wasm';
  dtype: { encoder_model: string; decoder_model_merged: string };
}

/**
 * Decoding config for the Whisper ONNX pipeline. Kept because the accuracy
 * bench (`bench/run.mjs`) runs the same code the app once used.
 *
 * Whisper tiny/base/small produce degenerate output (repetition loops, garbage
 * text, dropped words) with fp16/q4f16 decoder quantization on WebGPU, so the
 * WebGPU path pins fp32 encoder + q4 decoder; the CPU/WASM path uses q8.
 */
export function resolveAsrRuntime(hasWebgpu: boolean): AsrRuntimeConfig {
  if (hasWebgpu) {
    return { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } };
  }
  return { device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };
}

/**
 * 29, not 30: transformers.js #1357 documents that a 30s window corrupts
 * chunked alignment (merged segments / lost text). 29 is the working value.
 */
export const ASR_CHUNK_LENGTH_S = 29;
export const ASR_STRIDE_LENGTH_S = 5;

/** Guards against Whisper's hallucination/repetition loops on quiet audio. */
export const ASR_NO_REPEAT_NGRAM_SIZE = 3;
