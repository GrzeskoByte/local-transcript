/**
 * The one AudioContext for everything that reads capture streams while
 * recording: the Mic + Device mixer, recording diagnostics and the live
 * transcription tap. Never closed — closing a realtime context tears down
 * WebKitGTK's GStreamer sink on the web process's main thread, which is how
 * Stop used to freeze the AppImage. At Stop each user only disconnects its
 * own nodes; the idle context is suspended (a pipeline pause, not a teardown)
 * and resumed by the next recording.
 */
let shared: AudioContext | null = null;
let users = 0;

function create(): AudioContext {
  // 48 kHz matches the capture rate (no extra resample before Opus).
  try {
    return new AudioContext({ sampleRate: 48000 });
  } catch {
    return new AudioContext();
  }
}

/** Borrow the shared capture context; pair every call with `releaseCaptureContext`. */
export function acquireCaptureContext(): AudioContext {
  if (!shared || shared.state === 'closed') shared = create();
  users++;
  if (shared.state === 'suspended') void shared.resume().catch(() => undefined);
  return shared;
}

/** Done with the context: its nodes are already disconnected by the caller. */
export function releaseCaptureContext(ctx: AudioContext): void {
  if (ctx !== shared) return;
  users = Math.max(0, users - 1);
  if (users === 0 && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
}

/** True for the shared capture context (which must never be closed). */
export function isCaptureContext(ctx: AudioContext | null | undefined): boolean {
  return !!ctx && ctx === shared;
}
