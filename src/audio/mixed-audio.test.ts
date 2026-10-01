import { describe, expect, it } from 'vitest';
import { MixedAudioSource } from './mixed-audio';
import type { AudioSource } from './recorder';

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  stopped = false;
  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeNode {
  readonly targets: unknown[] = [];
  connect(node: unknown): void {
    this.targets.push(node);
  }
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination = new FakeNode();
  readonly sources: Array<{ stream: unknown; node: FakeNode }> = [];
  dest = Object.assign(new FakeNode(), {
    stream: new FakeStream(),
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
  });
  createMediaStreamDestination() {
    return this.dest;
  }
  createDynamicsCompressor() {
    const p = () => ({ value: 0 });
    return Object.assign(new FakeNode(), { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p() });
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
  createMediaStreamSource(stream: unknown) {
    const node = new FakeNode();
    this.sources.push({ stream, node });
    return node;
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

function input(fail?: Error) {
  const stream = new FakeStream();
  let stopped = 0;
  const source: AudioSource = {
    start: async () => {
      if (fail) throw fail;
      return stream as unknown as MediaStream;
    },
    stop: async () => {
      stopped++;
    },
  };
  return { source, stream, stopped: () => stopped };
}

function mixer(inputs: AudioSource[]) {
  const ctx = new FakeContext();
  const mix = new MixedAudioSource(inputs, () => ctx as unknown as AudioContext);
  return { ctx, mix };
}

describe('MixedAudioSource', () => {
  it('mixes every input into one mono stream', async () => {
    const mic = input();
    const device = input();
    const { ctx, mix } = mixer([mic.source, device.source]);
    const out = await mix.start();
    expect(out).toBe(ctx.dest.stream);
    expect(ctx.sources.map((s) => s.stream)).toEqual([mic.stream, device.stream]);
    expect(ctx.dest.channelCount).toBe(1);
    expect(ctx.dest.channelCountMode).toBe('explicit');
    expect(ctx.state).toBe('running');
  });

  it('ends the mixed track when any input ends, so the recorder reports it', async () => {
    const mic = input();
    const device = input();
    const { ctx, mix } = mixer([mic.source, device.source]);
    await mix.start();
    let ended = 0;
    ctx.dest.stream.track.addEventListener('ended', () => ended++);
    device.stream.track.end();
    expect(ctx.dest.stream.track.readyState).toBe('ended');
    expect(ended).toBe(1);
    mic.stream.track.end();
    expect(ended).toBe(1);
  });

  it('stops the other inputs when one fails to start', async () => {
    const mic = input();
    const device = input(new Error('no screen'));
    const { mix } = mixer([mic.source, device.source]);
    await expect(mix.start()).rejects.toThrow('no screen');
    expect(mic.stopped()).toBe(1);
  });

  it('stops inputs and closes the audio context on stop', async () => {
    const mic = input();
    const device = input();
    const { ctx, mix } = mixer([mic.source, device.source]);
    await mix.start();
    await mix.stop();
    expect(mic.stopped()).toBe(1);
    expect(device.stopped()).toBe(1);
    expect(ctx.dest.stream.track.stopped).toBe(true);
    expect(ctx.state).toBe('closed');
  });
});
