import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LLM_CONFIG,
  LLM_PRESETS,
  claudeResumeCommand,
  createLlmClient,
  parseSummaryReply,
  summaryUserPrompt,
} from './llm';
import type { LlmConfig } from './llm';

const config: LlmConfig = {
  ...DEFAULT_LLM_CONFIG,
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('parseSummaryReply', () => {
  it('splits summary and key-point sections', () => {
    const r = parseSummaryReply(
      '# Summary\n\nThey agreed to ship.\n\n# Key points\n\n- Ship on Friday\n- Anna owns docs\n',
    );
    expect(r.summary).toBe('They agreed to ship.');
    expect(r.keyPoints).toEqual(['Ship on Friday', 'Anna owns docs']);
  });

  it('keeps free-form replies as summary when no sections exist', () => {
    const r = parseSummaryReply('Just some text.');
    expect(r.summary).toBe('Just some text.');
    expect(r.keyPoints).toEqual([]);
  });

  it('ignores non-bullet lines in the key-points section', () => {
    const r = parseSummaryReply('# Key points\nIntro line\n- Real point\n');
    expect(r.keyPoints).toEqual(['Real point']);
  });
});

describe('summaryUserPrompt', () => {
  it('embeds the title and transcript', () => {
    const p = summaryUserPrompt('Weekly', 'Hello team.');
    expect(p).toContain('Weekly');
    expect(p).toContain('Hello team.');
  });
});

describe('createLlmClient', () => {
  it('rejects missing base URL or model', () => {
    expect(() => createLlmClient({ ...config, baseUrl: '' })).toThrow(/base URL/i);
    expect(() => createLlmClient({ ...config, model: '' })).toThrow(/model/i);
  });

  it('accepts a keyless local config (Ollama)', () => {
    expect(() => createLlmClient({ ...config, apiKey: '' })).not.toThrow();
  });
});

describe('LlmClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts an OpenAI-compatible body to base + completions path', async () => {
    let url = '';
    let body: { model?: string; messages?: Array<{ role?: string }> } = {};
    let auth: string | null = null;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(init?.body as string) as typeof body;
      auth = new Headers(init?.headers).get('Authorization');
      return json({ choices: [{ message: { content: '# Key points\n- A' } }] });
    });
    const r = await createLlmClient({ ...config, apiKey: 'sk-x' }).summarize('T', 'Hi.');
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(body.model).toBe('llama3.1');
    expect(body.messages?.map((m) => m.role)).toEqual(['system', 'user']);
    expect(auth).toBe('Bearer sk-x');
    expect(r.keyPoints).toEqual(['A']);
  });

  it('omits the Authorization header when no key is set', async () => {
    let auth: string | null = 'present';
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('Authorization');
      return json({ choices: [{ message: { content: 'ok' } }] });
    });
    await createLlmClient(config).testConnection();
    expect(auth).toBeNull();
  });

  it('surfaces HTTP errors with status and body', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad key', { status: 401 }));
    await expect(createLlmClient({ ...config, apiKey: 'bad' }).testConnection()).rejects.toThrow(
      /401.*bad key/,
    );
  });

  it('rejects empty model replies', async () => {
    vi.stubGlobal('fetch', async () => json({ choices: [] }));
    await expect(createLlmClient(config).summarize('T', 'Hi.')).rejects.toThrow(/empty/i);
  });
});

describe('LLM_PRESETS', () => {
  it('ships usable defaults for every preset', () => {
    for (const [id, p] of Object.entries(LLM_PRESETS)) {
      if (id === 'custom' || id === 'opencode' || id === 'claude') continue;
      expect(p.baseUrl, id).toMatch(/^https?:\/\//);
    }
  });

  it('lists the OpenCode preset', () => {
    expect(LLM_PRESETS.opencode.label).toMatch(/opencode/i);
  });
});

describe('opencode preset', () => {
  it('requires a model but no base URL', () => {
    expect(() =>
      createLlmClient({ ...config, preset: 'opencode', baseUrl: '', model: 'opencode/x' }),
    ).not.toThrow();
    expect(() => createLlmClient({ ...config, preset: 'opencode', baseUrl: '', model: '' })).toThrow(
      /model/i,
    );
  });

  it('needs the desktop app for summarize and testConnection', async () => {
    const client = createLlmClient({ ...config, preset: 'opencode', baseUrl: '', model: 'opencode/x' });
    await expect(client.summarize('T', 'Hi.')).rejects.toThrow(/desktop app/i);
    await expect(client.testConnection()).rejects.toThrow(/desktop app/i);
  });
});

describe('claude preset', () => {
  const claude: LlmConfig = { ...config, preset: 'claude', baseUrl: '', model: 'opus' };
  afterEach(() => vi.unstubAllGlobals());

  it('requires a model but no base URL, and needs the desktop app', async () => {
    expect(() => createLlmClient({ ...claude, model: '' })).toThrow(/model/i);
    const client = createLlmClient(claude);
    await expect(client.summarize('T', 'Hi.')).rejects.toThrow(/desktop app/i);
    await expect(client.testConnection()).rejects.toThrow(/desktop app/i);
  });

  it('summarizes through Claude Code and keeps the session id', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          return { text: '# Summary\nShipped.\n# Key points\n- Launch Friday', sessionId: 'sess-1' };
        },
      },
    });
    const result = await createLlmClient(claude).summarize('Standup', '**Alice:** launch Friday');
    expect(result).toEqual({ summary: 'Shipped.', keyPoints: ['Launch Friday'], sessionId: 'sess-1' });
    expect(calls[0]?.cmd).toBe('native_claude_summarize');
    const request = (calls[0]?.args as { request: Record<string, string> }).request;
    expect(request.model).toBe('opus');
    expect(request.transcript).toContain('launch Friday');
    expect(request.title).toContain('Standup');
  });

  it('builds the resume command', () => {
    expect(claudeResumeCommand('abc')).toBe('cd ~ && claude --resume abc');
  });
});
