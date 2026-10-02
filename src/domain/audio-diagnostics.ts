/**
 * Audio health of one recording, measured while it ran (src/audio/diagnostics.ts)
 * plus the sound server's log (src-tauri/src/audio_diag.rs). Stored on the
 * meeting (`Meeting.diagnostics`) and written as `diagnostics.json` next to the
 * mirrored audio, so a bad call can be explained after the fact.
 *
 * `assessDiagnostics` turns the numbers into plain findings with advice.
 */

export type ProbeRole = 'microphone' | 'device';

export interface InputSettings {
  label?: string;
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
}

/** 10-second bucket of one input. */
export interface LevelBucket {
  /** Seconds from the start of the recording. */
  t: number;
  rmsDb: number;
  peakDb: number;
  clipped: number;
}

export interface InputStats {
  role: ProbeRole;
  settings: InputSettings;
  /** Measurements taken (every 500 ms). */
  polls: number;
  /** Polls with signal (above -50 dBFS RMS). */
  activePolls: number;
  /** Active polls whose spectrum reaches above 4 kHz (wideband audio). */
  wideband4kPolls: number;
  /** Active polls whose spectrum reaches above 8 kHz. */
  wideband8kPolls: number;
  /** Polls with at least one sample at full scale. */
  clippedPolls: number;
  clippedSamples: number;
  sampledSamples: number;
  /** Polls of exact digital silence after the input had signal. */
  dropoutPolls: number;
  peakDb: number;
  timeline: LevelBucket[];
}

/** How much of the system sound reappears in the microphone. */
export interface BleedStats {
  /** Windows compared (system sound playing, microphone open). */
  windows: number;
  medianCorr: number;
  medianLagMs: number;
  /** Share of windows within ±10 ms of the median delay (1 = steady path). */
  lagConsistency: number;
}

export interface DiagEvent {
  atMs: number;
  kind: 'ended' | 'muted' | 'unmuted' | 'devices';
  role?: ProbeRole;
  detail: string;
}

export interface CardState {
  name: string;
  description: string;
  profile: string;
  codec?: string | null;
}

export interface AudioSnapshot {
  defaultSink?: string | null;
  defaultSource?: string | null;
  cards: CardState[];
}

/** Sound-server log (Linux desktop). */
export interface NativeAudioLog {
  server?: string | null;
  start: AudioSnapshot;
  events: { atMs: number; event: string; snapshot?: AudioSnapshot | null }[];
  dropped: number;
}

export interface AudioIssue {
  id: string;
  severity: 'problem' | 'notice';
  title: string;
  detail: string;
  atMs?: number;
}

export interface RecordingDiagnostics {
  version: 1;
  mode: string;
  startedAt: number;
  updatedAt: number;
  /** False while recording (periodic save) — true once stopped. */
  complete: boolean;
  userAgent: string;
  inputs: InputStats[];
  bleed?: BleedStats;
  events: DiagEvent[];
  native?: NativeAudioLog | null;
  /** Why measuring failed, if it did (the recording itself is unaffected). */
  error?: string;
  issues: AudioIssue[];
}

const NAMES: Record<ProbeRole, string> = { microphone: 'Microphone', device: 'System sound' };

export function formatAt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const pct = (n: number): string => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

/** A Bluetooth card profile used for calls (8/16 kHz, narrowband). */
export function isCallProfile(profile: string): boolean {
  return /headset[-_ ]head[-_ ]unit|handsfree|hfp|hsp/i.test(profile);
}

function cardLabel(card: CardState): string {
  return card.description || card.name;
}

function nativeIssues(log: NativeAudioLog, usesSystemAudio: boolean): AudioIssue[] {
  const issues: AudioIssue[] = [];
  const startCall = log.start.cards.filter((c) => isCallProfile(c.profile));
  for (const card of startCall) {
    issues.push({
      id: `bt-call:${card.name}`,
      severity: 'problem',
      title: `${cardLabel(card)} was in headset call mode`,
      detail:
        `The Bluetooth headset used its call profile (${card.profile}${card.codec ? `, ${card.codec}` : ''}) ` +
        'from the start: sound is reduced to telephone quality (8–16 kHz) in both directions, which makes ' +
        'transcripts worse. Zoom switches headsets to this mode when it uses the headset microphone — ' +
        'select the laptop or a USB microphone in Zoom to keep the headset in high-quality (A2DP) mode.',
    });
  }
  let prev = log.start;
  for (const e of log.events) {
    const snap = e.snapshot;
    if (!snap) continue;
    for (const card of snap.cards) {
      const before = prev.cards.find((c) => c.name === card.name);
      if (before && before.profile !== card.profile) {
        const toCall = isCallProfile(card.profile) && !isCallProfile(before.profile);
        issues.push({
          id: `profile:${card.name}:${e.atMs}`,
          severity: toCall ? 'problem' : 'notice',
          atMs: e.atMs,
          title: toCall
            ? `${cardLabel(card)} switched to headset call mode at ${formatAt(e.atMs)}`
            : `${cardLabel(card)} changed profile at ${formatAt(e.atMs)}`,
          detail: toCall
            ? `Profile ${before.profile} → ${card.profile}. Typically Zoom opening the headset microphone. ` +
              'From here on the sound is telephone quality, and the headset becomes a different output' +
              (usesSystemAudio ? ', so system sound may be missing from the recording after this point.' : '.') +
              ' Choose another microphone in Zoom to avoid it.'
            : `Profile ${before.profile} → ${card.profile}.`,
        });
      }
    }
    if (snap.defaultSink && prev.defaultSink && snap.defaultSink !== prev.defaultSink) {
      issues.push({
        id: `sink:${e.atMs}`,
        severity: usesSystemAudio ? 'problem' : 'notice',
        atMs: e.atMs,
        title: `Default output changed at ${formatAt(e.atMs)}`,
        detail:
          `${prev.defaultSink} → ${snap.defaultSink}.` +
          (usesSystemAudio
            ? ' The recording keeps capturing the output that was active when it started, so the call may be ' +
              'missing from here on if the call app moved to the new output.'
            : ''),
      });
    }
    if (snap.defaultSource && prev.defaultSource && snap.defaultSource !== prev.defaultSource) {
      issues.push({
        id: `source:${e.atMs}`,
        severity: 'notice',
        atMs: e.atMs,
        title: `Default microphone changed at ${formatAt(e.atMs)}`,
        detail: `${prev.defaultSource} → ${snap.defaultSource}. The recording keeps the microphone it started with.`,
      });
    }
    prev = snap;
  }
  return issues;
}

/** Plain-language findings, most serious first. */
export function assessDiagnostics(d: Omit<RecordingDiagnostics, 'issues'>): AudioIssue[] {
  const issues: AudioIssue[] = [];
  const usesSystemAudio = d.inputs.some((i) => i.role === 'device');

  for (const input of d.inputs) {
    const name = NAMES[input.role];
    const clipShare = input.sampledSamples > 0 ? (100 * input.clippedSamples) / input.sampledSamples : 0;
    const clipPollShare = input.activePolls > 0 ? (100 * input.clippedPolls) / input.activePolls : 0;
    if (input.clippedPolls >= 3 && (clipShare > 0.01 || clipPollShare > 2)) {
      issues.push({
        id: `clipping:${input.role}`,
        severity: 'problem',
        title: `${name} is clipping (too loud)`,
        detail:
          input.role === 'microphone'
            ? `${pct(clipPollShare)}% of the speech hits full scale and distorts (crackle). Lower the microphone ` +
              'input volume in your system sound settings (about 50–70%)' +
              (input.settings.autoGainControl ? ', and turn off automatic microphone volume in Zoom' : '') +
              '. Distortion cannot be removed afterwards.'
            : `${pct(clipPollShare)}% of the system sound hits full scale and distorts. Lower the volume inside ` +
              'the call app (not only the system volume).',
      });
    }
    if (input.polls >= 20 && input.activePolls / input.polls < 0.03) {
      issues.push({
        id: `silent:${input.role}`,
        // In a call you may just be listening: a quiet microphone is only a
        // problem when it is the only input.
        severity: input.role === 'microphone' && d.mode !== 'speaker' ? 'notice' : 'problem',
        title: input.role === 'microphone' ? 'Microphone was almost silent' : 'No system sound was captured',
        detail:
          input.role === 'microphone'
            ? 'Check that the right microphone is selected and not muted (Settings → Audio devices).'
            : 'The call probably played on a different output than the one recorded. Pick the output your ' +
              'headphones use under Settings → Audio devices → System sound from.',
      });
    } else if (input.activePolls >= 20) {
      const wide = input.wideband4kPolls / input.activePolls;
      if (wide < 0.02) {
        issues.push({
          id: `narrowband:${input.role}`,
          severity: 'problem',
          title: `${name} is telephone quality (nothing above 4 kHz)`,
          detail:
            'This is what a Bluetooth headset sounds like in call mode (HFP), or a narrowband call. ' +
            (input.role === 'microphone'
              ? 'Use the laptop or a USB microphone in Zoom so the headset stays in high-quality mode.'
              : 'Zoom put the headset into call mode; choose another microphone in Zoom to avoid it.'),
        });
      }
    }
    if (input.dropoutPolls >= 2) {
      issues.push({
        id: `dropouts:${input.role}`,
        severity: 'problem',
        title: `${name} dropped out ${input.dropoutPolls} times`,
        detail:
          'The input delivered pure digital silence in the middle of the recording — a device or Bluetooth ' +
          'link dropping, or the sound server switching devices.',
      });
    }
  }

  const b = d.bleed;
  if (b && b.windows >= 6 && b.medianCorr >= 0.15) {
    if (Math.abs(b.medianLagMs) < 3) {
      issues.push({
        id: 'loopback',
        severity: 'problem',
        title: 'The call audio is routed into the microphone',
        detail:
          'The system sound reaches the microphone track instantly (no acoustic delay), so the microphone ' +
          'is probably a monitor, loopback or virtual device. Select the real microphone.',
      });
    } else if (b.lagConsistency >= 0.4) {
      issues.push({
        id: 'bleed',
        severity: 'problem',
        title: 'Speakers leak into the microphone',
        detail:
          `The other side is picked up by the microphone about ${Math.round(b.medianLagMs)} ms later ` +
          `(similarity ${b.medianCorr.toFixed(2)}): it is recorded twice, as an echo. Wear headphones, ` +
          'or lower the speaker volume.',
      });
    }
  }

  for (const e of d.events) {
    if (e.kind === 'ended') {
      issues.push({
        id: `ended:${e.role}:${e.atMs}`,
        severity: 'problem',
        atMs: e.atMs,
        title: `${e.role ? NAMES[e.role] : 'An input'} stopped at ${formatAt(e.atMs)}`,
        detail: e.detail,
      });
    }
  }
  const mutes = d.events.filter((e) => e.kind === 'muted');
  if (mutes.length > 0) {
    issues.push({
      id: 'muted',
      severity: 'problem',
      atMs: mutes[0]!.atMs,
      title: `Input interrupted ${mutes.length} time${mutes.length > 1 ? 's' : ''} (first at ${formatAt(mutes[0]!.atMs)})`,
      detail:
        'The system paused an input (device busy, suspended or switched). ' + mutes.map((m) => m.detail).join(' '),
    });
  }
  for (const e of d.events.filter((x) => x.kind === 'devices')) {
    issues.push({
      id: `devices:${e.atMs}`,
      severity: 'notice',
      atMs: e.atMs,
      title: `Audio devices changed at ${formatAt(e.atMs)}`,
      detail: e.detail,
    });
  }

  if (d.native) issues.push(...nativeIssues(d.native, usesSystemAudio));

  const rank = (i: AudioIssue): number => (i.severity === 'problem' ? 0 : 1);
  return issues.sort((a, z) => rank(a) - rank(z) || (a.atMs ?? -1) - (z.atMs ?? -1));
}
