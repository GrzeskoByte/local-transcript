/**
 * External transcription server (opt-in): an Open WebUI instance, or any
 * server with the same OpenAI-style `POST …/audio/transcriptions` multipart
 * endpoint (`file` + optional `model` / `language`, JSON `{ text }` back).
 *
 *   curl -X POST "https://<server>/api/v1/audio/transcriptions" \
 *     -H "Authorization: Bearer <key>" -F "file=@audio.wav;type=audio/wav"
 *
 * The user configures everything (base URL, path, key, model). Privacy: unlike
 * the native engine this deliberately sends the recording's speech to that
 * server; the Settings card says so. Nothing is sent until the user turns it
 * on and clicks Transcribe (or Test connection).
 */

import { db } from '../storage/database';
import { encodeWav16 } from '../asr/wav';

export interface RemoteAsrConfig {
  /** Use the server instead of the on-device engine for whole-file runs. */
  enabled: boolean;
  /** Server address without the endpoint path, e.g. https://chat.example.com */
  baseUrl: string;
  /** Appended to baseUrl; default /api/v1/audio/transcriptions (Open WebUI). */
  path: string;
  /** Sent as `Authorization: Bearer …` when set. */
  apiKey: string;
  /** Optional `model` form field (Open WebUI uses its own STT setting). */
  model: string;
}

export const REMOTE_ASR_DEFAULT_PATH = '/api/v1/audio/transcriptions';

export const DEFAULT_REMOTE_ASR_CONFIG: RemoteAsrConfig = {
  enabled: false,
  baseUrl: '',
  path: REMOTE_ASR_DEFAULT_PATH,
  apiKey: '',
  model: '',
};

const REMOTE_ASR_CONFIG_KEY = 'remote-asr-config';

export async function getRemoteAsrConfig(): Promise<RemoteAsrConfig> {
  const stored = await db.kvGet<Partial<RemoteAsrConfig>>(REMOTE_ASR_CONFIG_KEY);
  if (!stored) return { ...DEFAULT_REMOTE_ASR_CONFIG };
  return {
    enabled: stored.enabled === true,
    baseUrl: stored.baseUrl?.trim() ?? '',
    path: stored.path?.trim() || REMOTE_ASR_DEFAULT_PATH,
    apiKey: stored.apiKey ?? '',
    model: stored.model?.trim() ?? '',
  };
}

export async function setRemoteAsrConfig(config: RemoteAsrConfig): Promise<void> {
  await db.kvSet(REMOTE_ASR_CONFIG_KEY, config);
}

/** Full endpoint URL, e.g. https://chat.example.com/api/v1/audio/transcriptions */
export function remoteAsrEndpoint(config: RemoteAsrConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  const path = config.path.trim() || REMOTE_ASR_DEFAULT_PATH;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Why the config cannot be used yet, or null when it can. */
export function remoteAsrConfigProblem(config: RemoteAsrConfig): string | null {
  const base = config.baseUrl.trim();
  if (!base) return 'Enter the server address.';
  let url: URL;
  try {
    url = new URL(remoteAsrEndpoint(config));
  } catch {
    return 'The server address is not a valid URL (include https://).';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The server address must start with http:// or https://.';
  return null;
}

/** True when whole-file transcription goes to the server. */
export function remoteAsrActive(config: RemoteAsrConfig): boolean {
  return config.enabled && remoteAsrConfigProblem(config) === null;
}

/** Short name for the transcript source line, e.g. "Open WebUI (chat.example.com)". */
export function remoteAsrLabel(config: RemoteAsrConfig): string {
  let host = config.baseUrl.trim();
  try {
    host = new URL(remoteAsrEndpoint(config)).host;
  } catch {
    // keep what the user typed
  }
  const model = config.model.trim();
  return `Open WebUI (${host}${model ? ` · ${model}` : ''})`;
}

/** Text of a transcription reply: `{ text }`, `{ segments: [{ text }] }` or plain text. */
export function parseTranscriptionReply(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (typeof data === 'string') return data.trim();
  if (data && typeof data === 'object') {
    const obj = data as { text?: unknown; segments?: unknown };
    if (typeof obj.text === 'string') return obj.text.trim();
    if (Array.isArray(obj.segments)) {
      return obj.segments
        .map((s) => (s && typeof (s as { text?: unknown }).text === 'string' ? (s as { text: string }).text.trim() : ''))
        .filter(Boolean)
        .join(' ');
    }
  }
  throw new Error('The transcription server replied without any text.');
}

export class RemoteAsrClient {
  constructor(private config: RemoteAsrConfig) {}

  /** Send one WAV and return its text. `language` 'auto' (or empty) is not sent. */
  async transcribeWav(wav: Uint8Array, language?: string, signal?: AbortSignal): Promise<string> {
    const problem = remoteAsrConfigProblem(this.config);
    if (problem) throw new Error(`Transcription server: ${problem}`);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    if (this.config.model.trim()) form.append('model', this.config.model.trim());
    if (language && language !== 'auto') form.append('language', language);
    const headers: Record<string, string> = {};
    if (this.config.apiKey.trim()) headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`;
    const endpoint = remoteAsrEndpoint(this.config);
    let response: Response;
    try {
      // No Content-Type: the browser sets the multipart boundary itself.
      response = await fetch(endpoint, { method: 'POST', headers, body: form, signal });
    } catch (err) {
      if (signal?.aborted) throw new Error('Transcription cancelled');
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach the transcription server at ${endpoint} (${msg}). Check the address, that the server is up, and that it allows this app (CORS).`,
      );
    }
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? ' — check the API key' : '';
      throw new Error(
        `Transcription server ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${hint}: ${
          body.slice(0, 200) || 'request failed'
        }`,
      );
    }
    return parseTranscriptionReply(body);
  }

  /** Round trip with one second of silence; resolves when the server answers 2xx with a reply. */
  async testConnection(): Promise<void> {
    await this.transcribeWav(encodeWav16(new Float32Array(16000), 16000));
  }
}
