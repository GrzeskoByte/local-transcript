#!/usr/bin/env python3
"""Diagnose audio problems in a Local Transcribe recording.

    uv run --with numpy scripts/analyze-recording.py "<Documents>/Local Transcribe/<meeting>"
    (or: pip install numpy; python3 scripts/analyze-recording.py <folder or audio file>)

Needs GStreamer (gst-launch-1.0; preferred) or ffmpeg. Per audio file, per 10 s window:
  - level (dBFS), clipping, dropouts (exact digital silence >20 ms),
  - bandwidth: speech with no energy above 4 kHz (or 8 kHz) means a Bluetooth
    headset in call mode (HFP/HSP narrowband / mSBC) — Zoom switches headsets
    to it as soon as it opens the headset microphone,
  - timestamp jumps reported by the decoder.
For Two-way recordings (microphone.* + device.*): how much of the device audio
leaks into the microphone (correlation + delay). A delay of a few to ~100 ms is
acoustic bleed (speakers → mic: wear headphones); ~0 ms means the same signal
is routed into both electronically (e.g. a loopback/monitor chosen as the mic).
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

import numpy as np

SR = 48000
AUDIO = {'.mp4', '.m4a', '.webm', '.ogg', '.opus', '.wav', '.flac', '.mp3'}


def decode(path: pathlib.Path) -> tuple[np.ndarray, list[str]]:
    """Prefer GStreamer: the app's MP4s (GStreamer 1.20 mp4mux, one `trun` per
    frame) are valid, but ffmpeg's demuxer mis-reads them and drops about half
    the audio. ffmpeg is the fallback for other files/hosts."""
    if shutil.which('gst-launch-1.0'):
        with tempfile.NamedTemporaryFile(suffix='.f32') as out:
            p = subprocess.run(
                ['gst-launch-1.0', '-q', 'filesrc', f'location={path}', '!', 'decodebin', '!', 'audioconvert',
                 '!', 'audioresample', '!', f'audio/x-raw,format=F32LE,rate={SR},channels=1',
                 '!', 'filesink', f'location={out.name}'],
                capture_output=True,
            )
            data = np.fromfile(out.name, np.float32)
            if p.returncode == 0 and len(data):
                return data, []
    p = subprocess.run(
        ['ffmpeg', '-v', 'warning', '-i', str(path), '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
        capture_output=True,
    )
    warnings = [l for l in p.stderr.decode(errors='replace').splitlines() if l.strip()]
    if path.suffix.lower() in ('.mp4', '.m4a'):
        warnings.insert(0, 'decoded with ffmpeg: install GStreamer (gst-launch-1.0) — ffmpeg mis-reads these MP4s')
    return np.frombuffer(p.stdout, np.float32), warnings


def db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-9))


def high_band(x: np.ndarray, hz: float) -> float:
    """Share (%) of energy above `hz` in active (non-quiet) frames."""
    f = 1024
    frames = [x[i:i + f] for i in range(0, len(x) - f, f)]
    frames = [w for w in frames if db(w) > -45]
    if not frames:
        return float('nan')
    spec = np.mean([np.abs(np.fft.rfft(w * np.hanning(f))) ** 2 for w in frames], axis=0)
    freqs = np.fft.rfftfreq(f, 1 / SR)
    return float(100 * spec[freqs > hz].sum() / spec.sum())


def dropouts(x: np.ndarray) -> int:
    z = (np.abs(x) < 1e-7).astype(np.int8)
    edges = np.diff(np.concatenate([[0], z, [0]]))
    runs = np.where(edges == -1)[0] - np.where(edges == 1)[0]
    return int((runs > SR * 0.02).sum())


def xcorr(a: np.ndarray, b: np.ndarray, max_lag_s: float) -> tuple[float, float]:
    n = 1 << int(np.ceil(np.log2(2 * len(a))))
    x = np.fft.irfft(np.fft.rfft(a, n) * np.conj(np.fft.rfft(b, n)), n)
    x /= np.linalg.norm(a) * np.linalg.norm(b) + 1e-12
    lag = int(max_lag_s * SR)
    v = np.concatenate([x[-lag:], x[:lag]])
    k = int(np.argmax(np.abs(v)))
    return float(abs(v[k])), (k - lag) / SR * 1000


def describe(name: str, x: np.ndarray, warnings: list[str]) -> None:
    print(f'\n== {name}: {len(x) / SR:.1f} s, level {db(x):.1f} dBFS, '
          f'clipped samples {int((np.abs(x) >= 0.99).sum())}, dropouts {dropouts(x)}')
    if warnings:
        print(f'   decoder warnings: {len(warnings)} (first: {warnings[0][:120]})')
    print('   window    level   >4kHz%  >8kHz%  dropouts  verdict')
    w = SR * 10
    for s in range(0, max(1, len(x) - w // 2), w):
        seg = x[s:s + w]
        lvl, h4, h8 = db(seg), high_band(seg, 4000), high_band(seg, 8000)
        verdict = []
        if lvl < -60:
            verdict.append('silent')
        elif h4 < 0.05:
            verdict.append('NARROWBAND ≤4 kHz (BT headset call mode HFP/CVSD?)')
        elif h8 < 0.01:
            verdict.append('≤8 kHz (BT headset mSBC call mode?)')
        if (np.abs(seg) >= 0.99).sum() > 10:
            verdict.append('CLIPPING')
        if dropouts(seg):
            verdict.append('DROPOUT')
        print(f'   {s // SR:4d}-{(s + len(seg)) // SR:<4d} {lvl:6.1f}  {h4:7.3f} {h8:7.3f}  {dropouts(seg):8d}  {", ".join(verdict)}')


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    target = pathlib.Path(sys.argv[1]).expanduser()
    files = [target] if target.is_file() else sorted(p for p in target.iterdir() if p.suffix.lower() in AUDIO)
    if not files:
        sys.exit(f'No audio files in {target}')
    tracks = {}
    for f in files:
        x, warnings = decode(f)
        tracks[f.stem] = x
        describe(f.name, x, warnings)
    mic, dev = tracks.get('microphone'), tracks.get('device')
    if mic is not None and dev is not None:
        n = min(len(mic), len(dev))
        # Per 10 s window (whole-file correlation is diluted by speech pauses
        # and level changes): leakage = strong correlation at a stable delay.
        w = SR * 10
        hits = []
        for s in range(0, n - w + 1, w):
            if db(dev[s:s + w]) < -50:
                continue
            hits.append(xcorr(mic[s:s + w], dev[s:s + w], 0.3))
        if not hits:
            print('\n== device → microphone leakage: no device audio to compare')
            return
        corrs = np.array([c for c, _ in hits])
        lags = np.array([l for _, l in hits])
        corr, lag, spread = float(np.median(corrs)), float(np.median(lags)), float(np.ptp(lags))
        print(f'\n== device → microphone leakage ({len(hits)} windows): correlation {corr:.2f}, '
              f'mic delay {lag:+.1f} ms (spread {spread:.1f} ms)')
        if corr < 0.1:
            print('   little leakage: the microphone does not pick up the call audio')
        elif abs(lag) < 2:
            print('   same signal in both with ~0 ms delay: routed electronically '
                  '(is a monitor/loopback/virtual device selected as the microphone?)')
        else:
            print('   acoustic bleed: the speakers reach the microphone — wear headphones '
                  'or lower the speaker volume')
    elif len(files) == 1:
        print('\n(Single mixed track: record in Two-way mode for a leakage measurement.)')


if __name__ == '__main__':
    main()
