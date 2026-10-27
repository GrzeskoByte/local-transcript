import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REMOTE_ASR_CONFIG,
  RemoteAsrClient,
  parseTranscriptionReply,
  remoteAsrActive,
  remoteAsrConfigProblem,
  remoteAsrEndpoint,
  remoteAsrLabel,
  type RemoteAsrConfig,
} from './remote-asr';
import { RemoteASREngine } from '../asr/remote-engine';

const config: RemoteAsrConfig = {
  ...DEFAULT_REMOTE_ASR_CONFIG,
  enabled: true,
  baseUrl: 'https://chat.example.com/',
  apiKey: 'sk-test',
};

const SR = 16000;
/** Speech-like tone ('s') or near silence ('_'), [kind, seconds] parts. */
function build(parts: [string, number][]): Float32Array {
  const total = parts.reduce((n, [, s]) => n + Math.round(s * SR), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[o + i] =
        kind === 's' ? 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) : 0.0005 * Math.sin(i);
    }
    o += n;
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('remote ASR config', () => {
  it('builds the Open WebUI endpoint from base URL + path', () => {
    expect(remoteAsrEndpoint(config)).toBe('https://chat.example.com/api/v1/audio/transcriptions');
    expect(remoteAsrEndpoint({ ...config, path: 'v1/audio/transcriptions' })).toBe(
      'https://chat.example.com/v1/audio/transcriptions',
    );
  });

  it('reports what is missing and is only active when enabled and valid', () => {
    expect(remoteAsrConfigProblem({ ...config, baseUrl: '' })).toMatch(/server address/);
    expect(remoteAsrConfigProblem({ ...config, baseUrl: 'chat.example.com' })).toMatch(/valid URL/);
    expect(remoteAsrConfigProblem({ ...config, baseUrl: 'ftp://x' })).toMatch(/http/);
    expect(remoteAsrConfigProblem(config)).toBeNull();
    expect(remoteAsrActive(config)).toBe(true);
    expect(remoteAsrActive({ ...config, enabled: false })).toBe(false);
    expect(remoteAsrActive(DEFAULT_REMOTE_ASR_CONFIG)).toBe(false);
  });

  it('labels the transcript source with host and model', () => {
    expect(remoteAsrLabel(config)).toBe('Open WebUI (chat.example.com)');
    expect(remoteAsrLabel({ ...config, model: 'whisper-1' })).toBe('Open WebUI (chat.example.com · whisper-1)');
  });
});

describe('parseTranscriptionReply', () => {
  it('reads { text }, segments and plain text', () => {
    expect(parseTranscriptionReply('{"text":" Hello there. "}')).toBe('Hello there.');
    expect(parseTranscriptionReply('{"segments":[{"text":" a"},{"text":"b "}]}')).toBe('a b');
    expect(parseTranscriptionReply('just text\n')).toBe('just text');
    expect(parseTranscriptionReply('')).toBe('');
    expect(() => parseTranscriptionReply('{"detail":"x"}')).toThrow(/without any text/);
  });
});

describe('RemoteAsrClient', () => {
  it('posts the WAV as multipart "file" with the bearer key, model and language', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"text":"ok"}'));
    const client = new RemoteAsrClient({ ...config, model: 'whisper-1' });
    expect(await client.transcribeWav(new Uint8Array([1, 2, 3]), 'de')).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://chat.example.com/api/v1/audio/transcriptions');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const form = init?.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('de');
  });

  it('never sends "auto" as a language, nor an empty model or key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"text":""}'));
    await new RemoteAsrClient({ ...config, apiKey: '' }).transcribeWav(new Uint8Array(4), 'auto');
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const form = init.body as FormData;
    expect(form.has('language')).toBe(false);
    expect(form.has('model')).toBe(false);
  });

  it('turns HTTP and network failures into readable errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not authenticated', { status: 401 }));
    await expect(new RemoteAsrClient(config).transcribeWav(new Uint8Array(4))).rejects.toThrow(
      /401.*check the API key.*Not authenticated/,
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(new RemoteAsrClient(config).transcribeWav(new Uint8Array(4))).rejects.toThrow(
      /Could not reach the transcription server.*CORS/,
    );
  });
});

describe('RemoteASREngine', () => {
  it('uploads speech chunks only and keeps their spans on the recording', async () => {
    let n = 0;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ text: `part ${++n}` })));
    const engine = new RemoteASREngine(config);
    await engine.initialize('ignored');
    const progress: number[] = [];
    const segments = await engine.transcribe(
      build([['_', 3], ['s', 4], ['_', 6], ['s', 3], ['_', 2]]),
      'm1',
      (r) => progress.push(r),
      { language: 'en' },
    );
    expect(fetchMock.mock.calls.length).toBe(segments.length);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.map((s) => s.text).sort()).toEqual(segments.map((_s, i) => `part ${i + 1}`).sort());
    // Leading silence is not part of the first chunk's span.
    expect(segments[0]!.startMs).toBeGreaterThan(2000);
    expect(segments.at(-1)!.endMs).toBeLessThanOrEqual(18_000);
    expect(progress.at(-1)).toBe(1);
  });

  it('sends nothing for silence', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const engine = new RemoteASREngine(config);
    await engine.initialize('ignored');
    expect(await engine.transcribe(build([['_', 5]]), 'm1')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to start without a usable server address', async () => {
    await expect(new RemoteASREngine({ ...config, baseUrl: '' }).initialize('x')).rejects.toThrow(/server address/);
  });

  it('cancel aborts the uploads in flight', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const engine = new RemoteASREngine(config);
    await engine.initialize('x');
    const run = engine.transcribe(build([['s', 4], ['_', 3], ['s', 4]]), 'm1');
    setTimeout(() => engine.cancel(), 10);
    await expect(run).rejects.toThrow(/cancel/i);
  });
});
