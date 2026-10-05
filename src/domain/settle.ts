/**
 * Wait for `work`, but never longer than `ms`: resolves with `fallback` when
 * it takes too long (or fails). For best-effort teardown on the Stop path —
 * a capture pipeline or native call that hangs must not hold the UI.
 */
export function settleWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
