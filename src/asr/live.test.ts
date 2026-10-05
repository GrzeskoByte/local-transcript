import { describe, expect, it } from 'vitest';
import { LIVE_RECOMMENDED_MODEL, LiveTranscriber, liveModelOptions, liveRequest, resolveLiveModel } from './live';
import type { CatalogModel } from './model-tiers';
import type { NativeSegment } from './native-types';

const SR = 16000;

function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t));
  }
  return out;
}

const quiet = (seconds: number) => new Float32Array(Math.round(seconds * SR)).fill(0.0003);

const model = (id: string, accuracy: number, installed = true): CatalogModel => ({
  id, label: id, engine: 'whisper', accuracy, tier: 'C', installed, downloadable: true, recommended: false, detail: '~1 MB',
});

describe('live model options', () => {
  it('lists installed models fastest first', () => {
    const opts = liveModelOptions([model('large-v3-turbo', 5), model('small', 3), model('base', 2)]);
    expect(opts.map((o) => o.id)).toEqual(['base', 'small', 'large-v3-turbo']);
    expect(opts.every((o) => o.ready)).toBe(true);
    expect(opts[0]!.detail).toContain('recommended for live');
    expect(opts[2]!.detail).toContain('may lag');
  });

  it('offers the recommended small model for download when missing', () => {
    const opts = liveModelOptions([model('large-v3-turbo', 5), model('base', 2, false), model('tiny', 1, false)]);
    expect(opts.map((o) => [o.id, o.ready])).toEqual([
      [LIVE_RECOMMENDED_MODEL, false],
      ['large-v3-turbo', true],
    ]);
  });

  it('falls back to a usable model when the saved one is not downloaded', () => {
    const opts = liveModelOptions([model('base', 2, false), model('small', 3)]);
    expect(resolveLiveModel('base', opts)?.id).toBe('small');
    expect(resolveLiveModel('base', liveModelOptions([model('base', 2, false)]))).toBeNull();
  });

  it('sends the model and language with the utterance', () => {
    expect(liveRequest('base', new Uint8Array([1, 2, 3]), 'pl')).toEqual({
      samplesBase64: 'AQID', sampleRate: SR, model: 'base', language: 'pl',
    });
  });
});

describe('LiveTranscriber', () => {
  it('transcribes each utterance as it ends and keeps recording-timeline timestamps', async () => {
    const calls: number[] = [];
    const invoke = async (req: { samplesBase64: string }): Promise<NativeSegment[]> => {
      calls.push(req.samplesBase64.length);
      return [{ startMs: 0, endMs: 1, text: ` line ${calls.length} ` }];
    };
    const live = new LiveTranscriber('m1', 'base', 'auto', invoke);
    live.push(quiet(1));
    live.push(speech(2));
    live.push(quiet(2));
    live.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(live.snapshot().segments.map((s) => s.text)).toEqual(['line 1']);
    live.push(speech(2));
    const segments = await live.finish();
    expect(segments.map((s) => s.text)).toEqual(['line 1', 'line 2']);
    expect(segments[0]!.startMs).toBeGreaterThan(700);
    expect(segments[0]!.startMs).toBeLessThan(1100);
    expect(segments[1]!.startMs).toBeGreaterThan(4500);
    expect(segments.map((s) => s.id)).toEqual(['m1-seg-0', 'm1-seg-1']);
    expect(live.snapshot().status).toBe('stopped');
  });

  it('sends nothing for silence', async () => {
    let calls = 0;
    const live = new LiveTranscriber('m2', 'base', 'auto', async () => {
      calls++;
      return [];
    });
    live.push(quiet(10));
    live.tick();
    expect(await live.finish()).toEqual([]);
    expect(calls).toBe(0);
  });

  it('gives up after repeated engine errors without throwing', async () => {
    const live = new LiveTranscriber('m3', 'base', 'auto', async () => {
      throw new Error('engine crashed');
    });
    for (let i = 0; i < 4; i++) {
      live.push(speech(1.5));
      live.push(quiet(2));
      live.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    const snap = live.snapshot();
    expect(snap.status).toBe('failed');
    expect(snap.error).toBe('engine crashed');
    expect(await live.finish()).toEqual([]);
  });

  it('cancel resolves finish() with what was done', async () => {
    let release!: () => void;
    const live = new LiveTranscriber('m4', 'base', 'auto', () =>
      new Promise<NativeSegment[]>((resolve) => {
        release = () => resolve([{ startMs: 0, endMs: 1, text: 'late' }]);
      }),
    );
    live.push(speech(2));
    const done = live.finish();
    await new Promise((r) => setTimeout(r, 0));
    live.cancel();
    expect(await done).toEqual([]);
    expect(live.wasCancelled).toBe(true);
    release();
  });
});
