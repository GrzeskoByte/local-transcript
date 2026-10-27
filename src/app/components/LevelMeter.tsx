import { useEffect, useRef, useState } from 'react';
import { isDesktopApp } from '../../platform/desktop';
import { pollLevelMonitor, startLevelMonitor, stopLevelMonitor, type MonitorInput } from '../../platform/system';
import { acquireCaptureContext, releaseCaptureContext } from '../../audio/capture-context';

/**
 * Level bars (DESIGN.md: ink cells, pink once the input is near clipping).
 * `level` 0..1 peak; the cells fill on a dB-ish scale so speech shows up.
 */
export function LevelBars({
  level,
  cells = 20,
  label,
  onInk = false,
}: {
  level: number;
  cells?: number;
  label: string;
  onInk?: boolean;
}): React.JSX.Element {
  // -60 dB … 0 dB → 0 … 1
  const db = level > 0 ? 20 * Math.log10(level) : -90;
  const lit = Math.max(0, Math.min(cells, Math.round(((db + 60) / 60) * cells)));
  const hot = Math.round(cells * 0.85);
  const status = level < 0.003 ? 'no signal' : level > 0.97 ? 'too loud' : level < 0.03 ? 'quiet' : 'good';
  return (
    <div className={`level-bars${onInk ? ' on-ink' : ''}`} role="img" aria-label={`${label}: level ${status}`}>
      {Array.from({ length: cells }, (_, i) => (
        <span key={i} className={i < lit ? (i >= hot ? 'hot' : 'on') : undefined} />
      ))}
    </div>
  );
}

/**
 * Live input levels before a recording starts. Desktop: the shell's level
 * monitor (no recording); elsewhere: getUserMedia for microphones only.
 * Inputs are compared by value, so a new array with the same devices does
 * not reopen them.
 */
export function useLevelMonitor(inputs: MonitorInput[], enabled = true): { levels: number[]; error: string | null } {
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = enabled ? JSON.stringify(inputs) : '';
  const decay = useRef<number[]>([]);

  useEffect(() => {
    if (!key) {
      setLevels([]);
      return;
    }
    const wanted = JSON.parse(key) as MonitorInput[];
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setError(null);
    // Peaks fall back slowly so the bars read like a meter, not a flicker.
    const show = (raw: number[]) => {
      decay.current = raw.map((v, i) => Math.max(v, (decay.current[i] ?? 0) * 0.7));
      setLevels([...decay.current]);
    };

    if (isDesktopApp()) {
      startLevelMonitor(wanted)
        .then(() => {
          if (stopped) return;
          timer = setInterval(() => {
            void pollLevelMonitor().then((l) => !stopped && show(l)).catch(() => undefined);
          }, 120);
        })
        .catch((e: unknown) => !stopped && setError(e instanceof Error ? e.message : String(e)));
      return () => {
        stopped = true;
        if (timer) clearInterval(timer);
        void stopLevelMonitor().catch(() => undefined);
      };
    }

    // Browser: microphones through getUserMedia on the shared capture context.
    const mics = wanted.filter((i) => i.role === 'microphone');
    if (!navigator.mediaDevices?.getUserMedia || mics.length === 0) return;
    const streams: MediaStream[] = [];
    const nodes: AudioNode[] = [];
    let ctx: AudioContext | null = null;
    void (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        ctx = acquireCaptureContext();
        const analysers: AnalyserNode[] = [];
        for (const mic of mics) {
          const match = devices.find((d) => d.kind === 'audioinput' && mic.device && d.label === mic.device);
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: match ? { deviceId: { exact: match.deviceId } } : true,
          });
          if (stopped) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streams.push(stream);
          const src = ctx.createMediaStreamSource(stream);
          const an = ctx.createAnalyser();
          an.fftSize = 2048;
          src.connect(an);
          nodes.push(src, an);
          analysers.push(an);
        }
        const buf = new Float32Array(2048);
        timer = setInterval(() => {
          show(
            analysers.map((an) => {
              an.getFloatTimeDomainData(buf);
              let peak = 0;
              for (const v of buf) peak = Math.max(peak, Math.abs(v));
              return peak;
            }),
          );
        }, 120);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      nodes.forEach((n) => n.disconnect());
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      if (ctx) releaseCaptureContext(ctx);
    };
  }, [key]);

  return { levels, error };
}
