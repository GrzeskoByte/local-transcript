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
 *
 * The `claude` preset works the same way with the user's Claude Code CLI
 * (`claude -p`, `src-tauri/src/claude_code.rs`): their Claude login, no API
 * key. Each summary is saved as a Claude Code session whose id is kept on the
 * summary, so the user can continue with `claude --resume <id>`.
 */

import { invokeDesktop, isDesktopApp } from '../platform/desktop';

export type LlmPreset = 'openai' | 'ollama' | 'openwebui' | 'opencode' | 'claude' | 'custom';

/** Presets that run a local agent CLI instead of an HTTP endpoint. */
export const LOCAL_AGENT_PRESETS: readonly LlmPreset[] = ['opencode', 'claude'];

export function isLocalAgentPreset(preset: LlmPreset): boolean {
  return LOCAL_AGENT_PRESETS.includes(preset);
}

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
  claude: { label: 'Claude Code (local agent)', baseUrl: '', model: 'opus' },
  custom: { label: 'Custom', baseUrl: '', model: '' },
};

export const LLM_PRESET_LABELS: Record<LlmPreset, string> = {
  openai: 'OpenAI-compatible API',
  ollama: 'Ollama (local)',
  openwebui: 'Open WebUI',
  opencode: 'OpenCode (local agent)',
  claude: 'Claude Code (local agent)',
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
  /** TL;DR: one or two sentences. */
  text: string;
  keyPoints: string[];
  /** "Owner: task (due)" lines; absent on summaries made before they existed. */
  actionItems?: string[];
  model: string;
  createdAt: number;
  /** Claude Code session that produced it (`claude --resume <id>`). */
  sessionId?: string;
}

export interface LlmSummaryResult {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  sessionId?: string;
}

// Short on purpose: a summary is read in seconds, the transcript has the rest.
const SUMMARY_SYSTEM = [
  'You summarize meeting transcripts for busy people. Be brief: the reader wants the outcome, not a retelling.',
  'Reply in Markdown with exactly these three sections and nothing else:',
  '# TL;DR',
  'One or two sentences: what the meeting was about and what was decided.',
  '# Key points',
  'At most 7 bullets, each under 20 words: decisions, agreements, important facts, open questions. Skip small talk and anything already in the TL;DR.',
  '# Action items',
  'One bullet per task as "Owner: task (due date)"; use "Unassigned" when no owner was named and omit the due date when none was given. Write "- None" when there are no tasks.',
  'No sub-bullets, no other headings, no text before the first heading or after the last bullet. Write in the language of the transcript.',
].join('\n');

export function summaryUserPrompt(title: string, transcriptMarkdown: string): string {
  return [`Meeting title: ${title || 'Untitled'}`, '', 'Transcript:', transcriptMarkdown].join('\n');
}

type SummarySection = 'summary' | 'keyPoints' | 'actionItems';

function sectionFor(heading: string): SummarySection | null {
  const h = heading.toLowerCase().replace(/[^a-z;]+/g, ' ').trim();
  if (/^(tl;?dr|summary)\b/.test(h)) return 'summary';
  if (/^(key points|highlights|decisions)\b/.test(h)) return 'keyPoints';
  if (/^(action items|actions|next steps|tasks|todo|to do)\b/.test(h)) return 'actionItems';
  return null;
}

const NONE = /^(none|n\/a|no action items|-)\.?$/i;

/** Split a model reply into TL;DR + key-point bullets + action items. */
export function parseSummaryReply(content: string): LlmSummaryResult {
  const text = content.trim();
  const parts: Record<SummarySection, string[]> = { summary: [], keyPoints: [], actionItems: [] };
  let current: SummarySection | null = null;
  let sawHeading = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,6}\s*(.+?)\s*#*$/.exec(line) ?? /^\*\*(.+?):?\*\*:?$/.exec(line);
    if (heading) {
      const section = sectionFor(heading[1]!);
      if (section) {
        current = section;
        sawHeading = true;
        continue;
      }
    }
    if (!current) {
      parts.summary.push(raw);
      continue;
    }
    if (current === 'summary') {
      parts.summary.push(raw);
      continue;
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet && !NONE.test(bullet[1]!.trim())) parts[current].push(bullet[1]!.trim());
  }
  if (!sawHeading) return { summary: text, keyPoints: [], actionItems: [] };
  return {
    summary: parts.summary.join('\n').trim(),
    keyPoints: parts.keyPoints,
    actionItems: parts.actionItems,
  };
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
    if (this.config.preset === 'claude') {
      const status = await getClaudeStatus();
      if (!status.available) throw new Error(CLAUDE_NOT_FOUND);
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
    if (this.config.preset === 'claude') {
      return this.summarizeViaClaude(title, transcriptMarkdown);
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

  private async summarizeViaClaude(
    title: string,
    transcriptMarkdown: string,
  ): Promise<LlmSummaryResult> {
    if (!isDesktopApp()) throw new Error('The Claude Code provider needs the desktop app.');
    // The transcript is piped on stdin; the argument carries the instruction.
    const result = await invokeDesktop<{ text: string; sessionId: string | null }>(
      'native_claude_summarize',
      {
        request: {
          model: this.config.model.trim(),
          system: SUMMARY_SYSTEM,
          message: `Summarize the meeting "${title || 'Untitled'}". Its transcript is attached below.`,
          transcript: summaryUserPrompt(title, transcriptMarkdown),
          title: `Meeting summary: ${title || 'Untitled'}`,
        },
      },
    );
    if (!result.text.trim()) throw new Error('Claude Code returned an empty reply');
    return { ...parseSummaryReply(result.text), sessionId: result.sessionId ?? undefined };
  }
}

const CLAUDE_NOT_FOUND =
  'Claude Code CLI not found. Install it from claude.com/claude-code and run `claude` once to log in.';

export interface ClaudeStatus {
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  /** `--model` aliases (opus, sonnet, …); full model names also work. */
  models: string[];
}

export async function getClaudeStatus(): Promise<ClaudeStatus> {
  if (!isDesktopApp()) throw new Error('The Claude Code provider needs the desktop app.');
  return invokeDesktop<ClaudeStatus>('native_claude_status');
}

/** Terminal command that reopens a summary's Claude Code session. */
export function claudeResumeCommand(sessionId: string): string {
  return `cd ~ && claude --resume ${sessionId}`;
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
/** What is missing before Summarize can run (null = ready). */
export function llmConfigProblem(config: LlmConfig): string | null {
  if (isLocalAgentPreset(config.preset)) {
    if (!isDesktopApp()) return `${LLM_PRESET_LABELS[config.preset]} needs the desktop app`;
    return config.model?.trim() ? null : 'no model chosen';
  }
  if (!config.baseUrl?.trim()) return 'no server address';
  if (!config.model?.trim()) return 'no model chosen';
  return null;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  if (isLocalAgentPreset(config.preset)) {
    if (!config.model?.trim()) throw new Error('LLM settings incomplete: model');
    return new LlmClient(config);
  }
  const missing: string[] = [];
  if (!config.baseUrl?.trim()) missing.push('base URL');
  if (!config.model?.trim()) missing.push('model');
  if (missing.length > 0) throw new Error(`LLM settings incomplete: ${missing.join(', ')}`);
  return new LlmClient(config);
}
