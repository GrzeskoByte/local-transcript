import { describe, expect, it } from 'vitest';
import { bestLag, frameStats, powerShareAbove, summarizeBleed } from './diagnostics';
import {
  assessDiagnostics,
  isCallProfile,
  type InputStats,
  type NativeAudioLog,
  type RecordingDiagnostics,
} from '../domain/audio-diagnostics';

function input(over: Partial<InputStats> = {}): InputStats {
  return {
    role: 'microphone',
    settings: {},
    polls: 200,
    activePolls: 150,
    wideband4kPolls: 120,
    wideband8kPolls: 60,
    clippedPolls: 0,
    clippedSamples: 0,
    sampledSamples: 200 * 16384,
    dropoutPolls: 0,
    peakDb: -6,
    timeline: [],
    ...over,
  };
}

function diag(over: Partial<Omit<RecordingDiagnostics, 'issues'>> = {}): Omit<RecordingDiagnostics, 'issues'> {
  return {
    version: 1,
    mode: 'dual',
    startedAt: 0,
    updatedAt: 0,
    complete: true,
    userAgent: '',
    inputs: [input(), input({ role: 'device' })],
    events: [],
    ...over,
  };
}

const ids = (d: Omit<RecordingDiagnostics, 'issues'>): string[] => assessDiagnostics(d).map((i) => i.id);

describe('measurement helpers', () => {
  it('measures level, clipping and silence', () => {
    const f = frameStats(new Float32Array([0.5, -1, 1, 0]));
    expect(f.clipped).toBe(2);
    expect(f.peakDb).toBeCloseTo(0);
    expect(f.silent).toBe(false);
    expect(frameStats(new Float32Array(8)).silent).toBe(true);
  });

  it('measures the spectrum share above a frequency', () => {
    const db = new Float32Array([0, 0, 0, -30, -30]);
    // bins 100 Hz apart: bins 3,4 (300, 400 Hz) are above 250 Hz.
    expect(powerShareAbove(db, 100, 250)).toBeCloseTo(0.002 / 2.002, 4);
  });

  it('finds the delay of a copy of the signal', () => {
    const dev = new Float32Array(1200).map((_, i) => Math.sin(i * 0.37) * Math.sin(i * 0.011) + ((i * 7919) % 13) / 30);
    const mic = new Float32Array(1200);
    for (let i = 25; i < mic.length; i++) mic[i] = 0.5 * dev[i - 25]!;
    const r = bestLag(mic, dev, 100);
    expect(r.lag).toBe(25);
    expect(r.corr).toBeGreaterThan(0.9);
  });

  it('summarizes bleed windows', () => {
    const b = summarizeBleed([
      { corr: 0.4, lagMs: 41 },
      { corr: 0.3, lagMs: 42 },
      { corr: 0.05, lagMs: 200 },
    ])!;
    expect(b.medianCorr).toBeCloseTo(0.3);
    expect(b.medianLagMs).toBe(42);
    expect(b.lagConsistency).toBeCloseTo(2 / 3);
  });
});

describe('assessDiagnostics', () => {
  it('reports nothing for healthy audio', () => {
    expect(assessDiagnostics(diag())).toEqual([]);
  });

  it('flags a clipping microphone and mentions auto gain', () => {
    const issues = assessDiagnostics(
      diag({ inputs: [input({ clippedPolls: 40, clippedSamples: 6000, settings: { autoGainControl: true } })] }),
    );
    expect(issues[0]!.id).toBe('clipping:microphone');
    expect(issues[0]!.detail).toMatch(/automatic microphone volume/);
  });

  it('flags narrowband (Bluetooth call mode) audio', () => {
    expect(ids(diag({ inputs: [input({ wideband4kPolls: 1 })] }))).toContain('narrowband:microphone');
  });

  it('treats a quiet microphone as a notice while listening to a call', () => {
    const quiet = input({ activePolls: 1 });
    expect(assessDiagnostics(diag({ inputs: [quiet, input({ role: 'device' })] }))[0]!.severity).toBe('notice');
    expect(assessDiagnostics(diag({ mode: 'speaker', inputs: [quiet] }))[0]!.severity).toBe('problem');
  });

  it('flags missing system sound', () => {
    expect(ids(diag({ inputs: [input(), input({ role: 'device', activePolls: 2 })] }))).toContain('silent:device');
  });

  it('tells acoustic bleed from an electronic loop', () => {
    expect(ids(diag({ bleed: { windows: 50, medianCorr: 0.33, medianLagMs: 41, lagConsistency: 0.8 } }))).toContain(
      'bleed',
    );
    expect(ids(diag({ bleed: { windows: 50, medianCorr: 0.6, medianLagMs: 0.5, lagConsistency: 1 } }))).toContain(
      'loopback',
    );
    expect(ids(diag({ bleed: { windows: 50, medianCorr: 0.05, medianLagMs: 41, lagConsistency: 1 } }))).toEqual([]);
  });

  it('reports a headset switching to call mode and the output changing', () => {
    const card = (profile: string) => ({ name: 'bluez_card.X', description: 'WH-1000XM4', profile, codec: null });
    const native: NativeAudioLog = {
      server: 'PulseAudio (on PipeWire)',
      start: { defaultSink: 'bluez_output.X.a2dp', defaultSource: 'alsa_input', cards: [card('a2dp-sink')] },
      events: [
        {
          atMs: 95_000,
          event: "Event 'change' on card #77",
          snapshot: { defaultSink: 'bluez_output.X.hfp', defaultSource: 'bluez_input.X', cards: [card('headset-head-unit')] },
        },
      ],
      dropped: 0,
    };
    const issues = assessDiagnostics(diag({ native }));
    const profile = issues.find((i) => i.id.startsWith('profile:'))!;
    expect(profile.severity).toBe('problem');
    expect(profile.title).toMatch(/switched to headset call mode at 1:35/);
    expect(issues.some((i) => i.id.startsWith('sink:') && i.severity === 'problem')).toBe(true);
    expect(issues.some((i) => i.id.startsWith('source:'))).toBe(true);
  });

  it('reports a headset already in call mode', () => {
    const native: NativeAudioLog = {
      start: { cards: [{ name: 'bluez_card.X', description: 'Buds', profile: 'headset-head-unit-msbc', codec: 'msbc' }] },
      events: [],
      dropped: 0,
    };
    expect(ids(diag({ native }))).toContain('bt-call:bluez_card.X');
  });

  it('reports inputs that ended or were muted', () => {
    const issues = assessDiagnostics(
      diag({
        events: [
          { atMs: 61_000, kind: 'muted', role: 'microphone', detail: 'x' },
          { atMs: 62_000, kind: 'ended', role: 'device', detail: 'y' },
        ],
      }),
    );
    expect(issues.map((i) => i.title)).toEqual(
      expect.arrayContaining(['Input interrupted 1 time (first at 1:01)', 'System sound stopped at 1:02']),
    );
  });

  it('knows call profiles', () => {
    expect(isCallProfile('headset-head-unit')).toBe(true);
    expect(isCallProfile('handsfree_head_unit')).toBe(true);
    expect(isCallProfile('a2dp-sink-aac')).toBe(false);
    expect(isCallProfile('output:analog-stereo+input:analog-stereo')).toBe(false);
  });
});
