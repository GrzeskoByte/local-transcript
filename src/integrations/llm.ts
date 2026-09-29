/**
 * Custom LLM provider for meeting summarization and key-point extraction.
 *
 * One OpenAI-compatible `POST {baseUrl}/chat/completions` code path covers all
 * three presets; only the defaults differ:
 * - OpenAI-compatible API: any key + base URL (OpenAI, OpenRouter, …)
 * - Ollama (local `llama` runtime): default http://localhost:11434/v1, no key
 * - Open WebUI: default http://localhost:8080/api/v1 + its API key
 * The completions path stays editable so odd gateways keep working.
 *
 * Privacy: unlike everything else in this app, this deliberately sends the
 * transcript text to the configured endpoint. Local Ollama stays on-device;
 * anything else leaves the machine. The Settings card says so.
 *
 * The `opencode` preset does not speak HTTP at all: it shells out to the
 * user's own OpenCode CLI (`opencode run`, headless) through the Tauri
 * sidecar (`src-tauri/src/opencode.rs`), so it uses the models and login
 * already configured in OpenCode. Desktop-only.
 */

import { invokeDesktop, isDesktopApp } from '../platform/desktop';

export type LlmPreset = 'openai' | 'ollama' | 'openwebui' | 'opencode' | 'custom';

export interface LlmConfig {
  preset: LlmPreset;
  /** Base URL without the completions path, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Appended to baseUrl; default /chat/completions */
  completionsPath: string;
  /** Optional — Ollama needs none */
  apiKey: string;
  model: string;
}

export const LLM_PRESETS: Record<LlmPreset, { label: string; baseUrl: string; model: string }> = {
  openai: { label: 'OpenAI-compatible API', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  openwebui: { label: 'Open WebUI', baseUrl: 'http://localhost:8080/api/v1', model: '' },
  opencode: { label: 'OpenCode (local agent)', baseUrl: '', model: '' },
  custom: { label: 'Custom', baseUrl: '', model: '' },
};

export const LLM_PRESET_LABELS: Record<LlmPreset, string> = {
  openai: 'OpenAI-compatible API',
  ollama: 'Ollama (local)',
  openwebui: 'Open WebUI',
  opencode: 'OpenCode (local agent)',
  custom: 'Custom',
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  preset: 'ollama',
  baseUrl: LLM_PRESETS.ollama.baseUrl,
  completionsPath: '/chat/completions',
  apiKey: '',
  model: LLM_PRESETS.ollama.model,
};

export interface MeetingSummary {
  text: string;
  keyPoints: string[];
  model: string;
  createdAt: number;
}

export interface LlmSummaryResult {
  summary: string;
  keyPoints: string[];
}

const SUMMARY_SYSTEM = [
  'You summarize meeting transcripts.',
  'Reply in Markdown with exactly two sections:',
  '# Summary (2-4 short paragraphs)',
  '# Key points (a bullet list, one fact or decision per bullet, no sub-bullets).',
  'Nothing before the first heading, nothing after the last bullet.',
].join('\n');

export function summaryUserPrompt(title: string, transcriptMarkdown: string): string {
  return [`Meeting title: ${title || 'Untitled'}`, '', 'Transcript:', transcriptMarkdown].join('\n');
}

/** Split a model reply into summary body + key-point bullets. */
export function parseSummaryReply(content: string): LlmSummaryResult {
  const text = content.trim();
  const pointsIdx = text.search(/^#\s*key points\s*$/gim);
  if (pointsIdx === -1) return { summary: text, keyPoints: [] };
  const summary = text.slice(0, pointsIdx).replace(/^#\s*summary\s*$/gim, '').trim();
  const rest = text.slice(pointsIdx);
  const keyPoints = rest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  return { summary, keyPoints };
}

export class LlmClient {
  constructor(private readonly config: LlmConfig) {}

  private endpoint(): string {
    const base = this.config.baseUrl.trim().replace(/\/+$/, '');
    const path = this.config.completionsPath.trim() || '/chat/completions';
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async post(body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey.trim()) headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`;
    const response = await fetch(this.endpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `LLM ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${
          detail.slice(0, 200) || 'request failed'
        }`,
      );
    }
    return response.json();
  }

  /** Minimal round-trip check; returns the model names the endpoint reports. */
  async testConnection(): Promise<{ models: string[] }> {
    if (this.config.preset === 'opencode') {
      const status = await getOpencodeStatus();
      if (!status.available) {
        throw new Error('OpenCode CLI not found. Install it from opencode.ai.');
      }
      return { models: status.models };
    }
    const data = (await this.post({
      model: this.config.model.trim(),
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 8,
      temperature: 0,
    })) as { choices?: Array<{ message?: { content?: string } }>; data?: Array<{ id?: string }> };
    const models = Array.isArray(data.data)
      ? data.data.map((m) => m.id).filter((id): id is string => !!id)
      : [];
    return { models };
  }

  async summarize(title: string, transcriptMarkdown: string): Promise<LlmSummaryResult> {
    if (this.config.preset === 'opencode') {
      return this.summarizeViaOpencode(title, transcriptMarkdown);
    }
    const data = (await this.post({
      model: this.config.model.trim(),
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: summaryUserPrompt(title, transcriptMarkdown) },
      ],
      temperature: 0.2,
    })) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM returned an empty reply');
    return parseSummaryReply(content);
  }

  private async summarizeViaOpencode(
    title: string,
    transcriptMarkdown: string,
  ): Promise<LlmSummaryResult> {
    if (!isDesktopApp()) throw new Error('The OpenCode provider needs the desktop app.');
    const message = [
      SUMMARY_SYSTEM,
      '',
      summaryUserPrompt(title, transcriptMarkdown),
      '',
      'Answer directly with the two Markdown sections. Do not call any tools; use only the attached transcript.',
    ].join('\n');
    const text = await invokeDesktop<string>('native_opencode_summarize', {
      request: {
        model: this.config.model.trim(),
        message,
        transcript: transcriptMarkdown,
      },
    });
    if (!text.trim()) throw new Error('OpenCode returned an empty reply');
    return parseSummaryReply(text);
  }
}

export interface OpencodeStatus {
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  serverUrl: string | null;
  models: string[];
}

export async function getOpencodeStatus(): Promise<OpencodeStatus> {
  if (!isDesktopApp()) throw new Error('The OpenCode provider needs the desktop app.');
  return invokeDesktop<OpencodeStatus>('native_opencode_status');
}

/** Convenience factory that validates the config first. */
export function createLlmClient(config: LlmConfig): LlmClient {
  if (config.preset === 'opencode') {
    if (!config.model?.trim()) throw new Error('LLM settings incomplete: model');
    return new LlmClient(config);
  }
  const missing: string[] = [];
  if (!config.baseUrl?.trim()) missing.push('base URL');
  if (!config.model?.trim()) missing.push('model');
  if (missing.length > 0) throw new Error(`LLM settings incomplete: ${missing.join(', ')}`);
  return new LlmClient(config);
}
