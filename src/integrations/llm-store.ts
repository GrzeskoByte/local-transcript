/**
 * Persistence for the LLM provider settings. The API key (if any) lives only
 * in this device's IndexedDB, next to the GitLab token.
 */

import { db } from '../storage/database';
import { DEFAULT_LLM_CONFIG, type LlmConfig, type LlmPreset } from './llm';

const LLM_CONFIG_KEY = 'llm-config';

const PRESETS: LlmPreset[] = ['openai', 'ollama', 'openwebui', 'opencode', 'claude', 'custom'];

/** Read the stored config, falling back to defaults field by field. */
export async function getLlmConfig(): Promise<LlmConfig> {
  const stored = await db.kvGet<Partial<LlmConfig>>(LLM_CONFIG_KEY);
  if (!stored) return { ...DEFAULT_LLM_CONFIG };
  const preset = PRESETS.includes(stored.preset as LlmPreset)
    ? (stored.preset as LlmPreset)
    : DEFAULT_LLM_CONFIG.preset;
  return {
    preset,
    baseUrl: stored.baseUrl?.trim() || DEFAULT_LLM_CONFIG.baseUrl,
    completionsPath: stored.completionsPath?.trim() || DEFAULT_LLM_CONFIG.completionsPath,
    apiKey: stored.apiKey ?? '',
    model: stored.model?.trim() || DEFAULT_LLM_CONFIG.model,
  };
}

export async function setLlmConfig(config: LlmConfig): Promise<void> {
  await db.kvSet(LLM_CONFIG_KEY, config);
}
