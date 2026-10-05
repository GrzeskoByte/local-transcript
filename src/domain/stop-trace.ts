/**
 * How long each step of Stop took. Saved with the meeting and printed to the
 * terminal the desktop app runs from, so a slow Stop names the step that
 * held it (a capture device release, the MediaRecorder, a disk write…).
 */
export interface StopStep {
  step: string;
  ms: number;
}

export class StopTrace {
  readonly steps: StopStep[] = [];
  private readonly startedAt = now();

  /** Run `work` (sync or async) and record its duration under `step`. */
  async time<T>(step: string, work: () => T | Promise<T>): Promise<T> {
    const t0 = now();
    try {
      return await work();
    } finally {
      this.add(step, now() - t0);
    }
  }

  add(step: string, ms: number): void {
    this.steps.push({ step, ms: Math.round(ms) });
  }

  totalMs(): number {
    return Math.round(now() - this.startedAt);
  }

  slowest(): StopStep | null {
    return slowestStep(this.steps);
  }
}

export function slowestStep(steps: StopStep[]): StopStep | null {
  return steps.reduce<StopStep | null>((a, s) => (!a || s.ms > a.ms ? s : a), null);
}

/** One line per step, slowest marked: `Stop took 4210 ms: diagnostics 12 ms, …`. */
export function formatStopTrace(steps: StopStep[], totalMs: number): string {
  const slow = slowestStep(steps);
  const parts = steps.map((s) => `${s.step} ${s.ms} ms${s === slow && s.ms >= 500 ? ' (slowest)' : ''}`);
  return `Stop took ${totalMs} ms: ${parts.join(', ')}`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Let the browser paint before continuing (e.g. show "Saving recording…"
 * before teardown work that may block the main thread). Bounded: animation
 * frames do not fire in a hidden window.
 */
export function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(finish, 0));
  });
}
