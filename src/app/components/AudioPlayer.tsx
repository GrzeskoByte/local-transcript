import { forwardRef, useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import { applyPlaybackOutput } from '../../audio/devices';
import { decodeForPlayback, formatClock, PcmPlayer, peaks, playbackContext } from '../../audio/player';

export interface AudioPlayerHandle {
  /** Seek to `seconds` and play (transcript segment clicks). */
  playFrom(seconds: number): void;
}

interface Props {
  /** Reads the recording; called once, on the first interaction. */
  load: () => Promise<Blob | null>;
  /** Shown before the audio is decoded. */
  durationHintMs?: number;
  label?: string;
}

const BINS = 240;
const SKIP_S = 15;

/**
 * Web Audio player (see `src/audio/player.ts` for why not <audio>). The
 * recording is decoded on the first interaction, not on mount, so opening a
 * meeting stays instant and nothing runs right after Stop.
 */
export const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
  { load, durationHintMs = 0, label },
  ref,
) {
  const playerRef = useRef<PcmPlayer | null>(null);
  const loadingRef = useRef<Promise<PcmPlayer> | null>(null);
  const mounted = useRef(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const envelope = useRef<Float32Array | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  const ensure = useCallback((): Promise<PcmPlayer> => {
    if (playerRef.current) return Promise.resolve(playerRef.current);
    if (loadingRef.current) return loadingRef.current;
    setStatus('loading');
    setError(null);
    const loading = load()
      .then((blob) => {
        if (!blob) throw new Error('Recording audio not found.');
        return decodeForPlayback(blob);
      })
      .then((audio) => {
        const ctx = playbackContext();
        void applyPlaybackOutput(ctx);
        const player = new PcmPlayer(audio, ctx, () => {
          if (mounted.current) rerender();
        });
        if (!mounted.current) {
          player.dispose();
          throw new Error('unmounted');
        }
        envelope.current = peaks(audio.pcm, BINS);
        playerRef.current = player;
        setStatus('ready');
        return player;
      })
      .catch((err: unknown) => {
        loadingRef.current = null;
        if (mounted.current) {
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      });
    loadingRef.current = loading;
    return loading;
  }, [load]);

  const withPlayer = useCallback(
    (fn: (p: PcmPlayer) => void | Promise<void>) => {
      ensure()
        .then(fn)
        .catch(() => undefined);
    },
    [ensure],
  );

  useImperativeHandle(
    ref,
    () => ({
      playFrom: (seconds: number) =>
        withPlayer(async (p) => {
          p.seek(seconds);
          await p.play();
        }),
    }),
    [withPlayer],
  );

  const player = playerRef.current;
  const duration = player ? player.duration : durationHintMs / 1000;
  const current = player ? player.currentTime : 0;
  const isPlaying = player?.playing ?? false;

  // Waveform overview with the played part highlighted.
  useEffect(() => {
    const canvas = canvasRef.current;
    const env = envelope.current;
    if (!canvas || !env) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const styles = getComputedStyle(canvas);
    const played = styles.getPropertyValue('--wave-played').trim() || '#4f46e5';
    const rest = styles.getPropertyValue('--wave-rest').trim() || '#cbd5e1';
    const progress = duration > 0 ? current / duration : 0;
    const bar = width / env.length;
    for (let i = 0; i < env.length; i++) {
      const h = Math.max(2, Math.min(1, env[i]! * 1.6) * (height - 2));
      g.fillStyle = (i + 0.5) / env.length <= progress ? played : rest;
      g.fillRect(i * bar, (height - h) / 2, Math.max(1, bar - 1), h);
    }
  });

  const onWaveClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    withPlayer((p) => p.seek(ratio * p.duration));
  };

  return (
    <div className="audio-player" role="group" aria-label={label ? `${label} player` : 'Audio player'}>
      <div className="audio-player-row">
        <button
          type="button"
          className="btn btn-primary player-play"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          disabled={status === 'loading'}
          onClick={() => withPlayer((p) => (p.playing ? p.pause() : p.play()))}
        >
          {status === 'loading' ? '…' : isPlaying ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="btn player-skip"
          aria-label={`Back ${SKIP_S} seconds`}
          disabled={status === 'loading'}
          onClick={() => withPlayer((p) => p.seek(p.currentTime - SKIP_S))}
        >
          −{SKIP_S}s
        </button>
        <button
          type="button"
          className="btn player-skip"
          aria-label={`Forward ${SKIP_S} seconds`}
          disabled={status === 'loading'}
          onClick={() => withPlayer((p) => p.seek(p.currentTime + SKIP_S))}
        >
          +{SKIP_S}s
        </button>
        <input
          type="range"
          className="player-seek"
          aria-label="Seek"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(current, duration)}
          disabled={status === 'loading'}
          onChange={(e) => {
            const t = Number(e.target.value);
            withPlayer((p) => p.seek(t));
          }}
        />
        <span className="player-time" aria-label="Playback position">
          {formatClock(current)} / {formatClock(duration)}
        </span>
      </div>
      {status === 'ready' && (
        <canvas ref={canvasRef} className="player-wave" aria-hidden="true" onClick={onWaveClick} />
      )}
      {status === 'loading' && <p className="muted small mb-0">Loading audio…</p>}
      {status === 'error' && (
        <p className="error mb-0" role="alert">
          This recording could not be decoded for playback{error ? ` (${error})` : ''}. It is still stored and can be
          exported or transcribed.
        </p>
      )}
    </div>
  );
});
