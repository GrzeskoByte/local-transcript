import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store.tsx';
import { LevelBars, useLevelMonitor } from '../components/LevelMeter.tsx';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { getMicrophoneDevice, listDevices, setMicrophoneDevice, type DeviceOption } from '../../audio/devices';
import { primeMicrophonePermission, queryMicrophonePermission } from '../../audio/permissions';
import { MicrophoneAudioSource } from '../../audio/microphone';
import { LivePcmTap } from '../../audio/live-tap';
import { playbackContext } from '../../audio/player';
import { encodeWav16 } from '../../asr/wav';
import { liveRequest } from '../../asr/live';
import { describeGpu } from '../../asr/model-manager';
import type { CatalogModel } from '../../asr/model-tiers';
import type { NativeSegment } from '../../asr/native-types';
import { invokeDesktop, isDesktopApp } from '../../platform/desktop';
import { setPref } from '../../platform/prefs';
import { formatBytes, openPrivacySettings, pickFolder, setStorageDir, systemInfo, type SystemInfo } from '../../platform/system';
import { autoTranscribeEnabled, setAutoTranscribeEnabled } from '../auto-transcribe';
import {
  defaultSource,
  keepAudio,
  meetingLanguages,
  recordingPrefs,
  setDefaultSource,
  setKeepAudio,
  setMeetingLanguages,
  setRecordingPrefs,
  setSetupDone,
  setWrapPrefs,
  wrapPrefs,
  type KeepAudio,
} from '../preferences';
import { Keys, useShortcuts } from '../App.tsx';
import { formatClock } from '../../audio/player';
import { useQuickRecord } from '../quick-record';

const STEPS = ['Welcome', 'Microphone', 'Calls & computer audio', 'Speech model', 'Try it', 'Your files'];
const LANGS: Array<[string, string]> = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['pl', 'Polish'],
  ['ca', 'Catalan'],
  ['de', 'German'],
  ['fr', 'French'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
];
const TEST_SENTENCE = 'Local Transcriber keeps my meetings on this laptop.';

function finish(go: ReturnType<typeof useApp>['go']): void {
  setSetupDone(true);
  go({ name: 'home' });
}

/** First run, in short (DESIGN.md "First run — three steps"): mic, model, folder, or the full setup. */
export function FirstRun(): React.JSX.Element {
  const { go, modelCatalog, downloadModel, modelDownload, storageDir } = useApp();
  const [mic, setMic] = useState<DeviceOption[]>([]);
  const [micId, setMicId] = useState(getMicrophoneDevice()?.label ?? '');
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(storageDir);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void listDevices('audioinput').then((l) => setMic(l.options)).catch(() => undefined);
    if (isDesktopApp()) void systemInfo().then(setInfo).catch(() => undefined);
  }, []);
  useEffect(() => setFolder(storageDir), [storageDir]);
  const { levels } = useLevelMonitor([{ role: 'microphone', device: micId }]);
  const recs = recommend(modelCatalog, meetingLanguages(), info);
  const chosen = recs.find((r) => r.model.id === pick) ?? recs.find((r) => r.ok);
  return (
    <div className="first-run">
      <section className="first-hero">
        <span className="saved-tag">local-transcriber</span>
        <h1>Your meetings. Your laptop.</h1>
        <p className="hero-lede">Three steps, about a minute.</p>
        <p>
          Recording works right away. Transcription runs on this computer with a model you pick — nothing is uploaded, ever,
          unless you share it yourself.
        </p>
        <div className="btn-row">
          <button type="button" className="btn btn-hero" onClick={() => go({ name: 'setup', step: 1 })}>
            Finish setup
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPref('setup-skipped', 'true');
              finish(go);
            }}
          >
            Skip — just record
          </button>
        </div>
      </section>
      <div className="first-steps">
        <section className="card" aria-label="Step 1, microphone">
          <div className="card-title">
            <strong>1 · Microphone</strong>
            {(levels[0] ?? 0) > 0.02 && <span className="badge badge-ok">[x] done</span>}
          </div>
          <label className="field-label mt-0" htmlFor="fmic">
            Record from
          </label>
          <select
            id="fmic"
            className="input"
            value={micId}
            onChange={(e) => {
              setMicId(e.target.value);
              const opt = mic.find((o) => o.label === e.target.value);
              setMicrophoneDevice(opt ? { deviceId: opt.id, label: opt.label } : null);
            }}
          >
            <option value="">System default</option>
            {mic.map((o) => (
              <option key={o.id} value={o.label}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="mt-3">
            <LevelBars level={levels[0] ?? 0} label="Level" />
          </div>
          <p className="small muted mb-0">{(levels[0] ?? 0) > 0.02 ? 'We can hear you. Level is good.' : 'Say something — the bars should move.'}</p>
        </section>
        <section className="card" aria-label="Step 2, speech model">
          <div className="card-title">
            <strong>2 · Pick a speech model now</strong>
          </div>
          <div className="model-picks">
            {recs.slice(0, 3).map((r) => (
              <label key={r.model.id} className={`model-pick${chosen?.model.id === r.model.id ? ' selected' : ''}${r.ok ? '' : ' off'}`}>
                <input type="radio" name="fr-model" disabled={!r.ok} checked={chosen?.model.id === r.model.id} onChange={() => setPick(r.model.id)} />
                <span className={`tier-badge tier-${r.model.tier}`}>{r.model.tier}</span>
                <span className="grow">
                  <b>{r.model.label}</b>
                  <small className="muted"> {r.why}</small>
                </span>
                <span className="small">{formatBytes(r.model.sizeBytes)}</span>
              </label>
            ))}
          </div>
          {modelDownload ? (
            <ModelDownloadProgress />
          ) : (
            <button
              type="button"
              className="btn btn-primary mt-3"
              disabled={!chosen || chosen.model.installed}
              onClick={() => chosen && downloadModel(chosen.model.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
            >
              {chosen?.model.installed ? '[x] Downloaded' : `Download ${formatBytes(chosen?.model.sizeBytes)}`}
            </button>
          )}
          <p className="small muted mb-0">Downloads in the background — you can record meanwhile.</p>
        </section>
        <section className="card" aria-label="Step 3, where files live">
          <div className="card-title">
            <strong>3 · Where your files live</strong>
          </div>
          <code className="block">{folder ?? 'Your browser storage'}</code>
          {isDesktopApp() && (
            <button
              type="button"
              className="btn btn-sm mt-3"
              onClick={() =>
                void pickFolder('Where should meetings be saved?')
                  .then((p) => (p ? setStorageDir(p, true).then(setFolder) : null))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              }
            >
              Change…
            </button>
          )}
        </section>
      </div>
      {error && <p className="warn">{error}</p>}
    </div>
  );
}

/** The guided setup (DESIGN.md steps 07–14). Step 20 = the microphone is blocked. */
export function Setup({ step }: { step: number }): React.JSX.Element {
  const { go } = useApp();
  const blocked = step === 20;
  const n = blocked ? 2 : Math.min(7, Math.max(1, step));
  const goStep = (s: number): void => go({ name: 'setup', step: s });
  return (
    <div className="setup">
      <header className="setup-top">
        <span className="brand-name">local-transcriber · setup</span>
        <button type="button" className="link-btn" onClick={() => finish(go)}>
          Skip setup — just record
        </button>
      </header>
      {n === 7 ? (
        <SetupDone />
      ) : (
        <div className="setup-grid">
          <aside className="card setup-side" aria-label="Setup steps">
            <div className="card-title">
              <strong>Setup</strong>
            </div>
            <ol className="setup-steps">
              {STEPS.map((name, i) => (
                <li key={name} className={i + 1 === n ? 'now' : i + 1 < n ? 'done' : undefined}>
                  <span className="wrap-n">{i + 1 < n ? '✓' : i + 1}</span> {name}
                  <span className="small muted">{i + 1 < n ? 'done' : i + 1 === n ? 'now' : ''}</span>
                </li>
              ))}
            </ol>
            <p className="small muted mb-0">About 2 minutes. Every step can be skipped and redone later in Settings.</p>
          </aside>
          <main className="setup-main">
            {n === 1 && <Welcome next={() => goStep(2)} />}
            {n === 2 && !blocked && <MicStep back={() => goStep(1)} next={() => goStep(3)} blocked={() => goStep(20)} />}
            {blocked && <MicBlocked back={() => goStep(2)} next={() => goStep(3)} />}
            {n === 3 && <CallsStep back={() => goStep(2)} next={() => goStep(4)} />}
            {n === 4 && <ModelStep back={() => goStep(3)} next={() => goStep(5)} />}
            {n === 5 && <TryStep back={() => goStep(4)} next={() => goStep(6)} />}
            {n === 6 && <FilesStep back={() => goStep(5)} next={() => goStep(7)} />}
          </main>
        </div>
      )}
    </div>
  );
}

function StepHead({ kicker, title, lede }: { kicker: string; title: string; lede?: string }): React.JSX.Element {
  return (
    <div className="setup-head">
      <span className="kicker">{kicker}</span>
      <h1>{title}</h1>
      {lede && <p className="hero-lede">{lede}</p>}
    </div>
  );
}

function Welcome({ next }: { next: () => void }): React.JSX.Element {
  return (
    <section className="setup-welcome">
      <StepHead
        kicker="Welcome"
        title="Your meetings stay on your laptop."
        lede="Local Transcriber records meetings and turns them into text on this computer. Before you start, here is what it promises."
      />
      <ul className="promises">
        <li>
          <span className="mark">[x]</span> <b>Nothing leaves this computer.</b> No account, no cloud, no telemetry. You share a
          transcript only when you choose to.
        </li>
        <li>
          <span className="mark">[x]</span> <b>Recording never waits for setup.</b> Record now; transcribe later, once a model is
          ready.
        </li>
        <li>
          <span className="mark">[x]</span> <b>Your files are plain files.</b> Audio, text and JSON in a folder you pick. Delete a
          meeting and every trace goes.
        </li>
      </ul>
      <div className="btn-row">
        <button type="button" className="btn btn-hero" onClick={next}>
          Set up · 2 min →
        </button>
        <span className="small self-center">Needs a 0.5–1.6 GB download for the speech model.</span>
      </div>
    </section>
  );
}

function MicStep({ back, next, blocked }: { back: () => void; next: () => void; blocked: () => void }): React.JSX.Element {
  const { nativeRecording } = useApp();
  const [devices, setDevices] = useState<string[]>([]);
  const [chosen, setChosen] = useState(getMicrophoneDevice()?.label ?? '');
  const [permission, setPermission] = useState<string>('prompt');
  useEffect(() => {
    void (async () => {
      if (!isDesktopApp()) {
        const failure = await primeMicrophonePermission();
        if (failure && failure.code === 'denied') return blocked();
      }
      setPermission(await queryMicrophonePermission().catch(() => 'unknown'));
      const names = nativeRecording?.inputs.map((d) => d.name) ?? (await listDevices('audioinput').then((l) => l.options.map((o) => o.label)).catch(() => []));
      setDevices(names.filter(Boolean));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeRecording]);
  const inputs = useMemo(() => devices.slice(0, 5).map((d) => ({ role: 'microphone' as const, device: d })), [devices]);
  const { levels, error } = useLevelMonitor(inputs, inputs.length > 0);
  const pick = (label: string): void => {
    setChosen(label);
    setMicrophoneDevice(label ? { deviceId: '', label } : null);
  };
  const loudest = devices[levels.indexOf(Math.max(...levels, 0))];
  return (
    <section>
      <StepHead
        kicker="Step 2 of 6 · Microphone"
        title="Can it hear you?"
        lede="We ask for the microphone now, so a real meeting never starts with a pop-up. Say a few words and pick the device whose bar jumps."
      />
      <section className="card" aria-label="Microphones">
        <div className="card-title">
          <strong>Microphones · {devices.length} found</strong>
          <span className="badge">{permission === 'granted' ? '[x] access allowed' : permission === 'denied' ? '[!] blocked' : 'access'}</span>
        </div>
        {devices.length === 0 && <p className="muted">No microphone found yet.</p>}
        <div className="mic-list" role="radiogroup" aria-label="Microphone">
          {devices.map((d, i) => {
            const level = levels[i] ?? 0;
            return (
              <label key={d} className={`mic-row${(chosen || loudest) === d ? ' selected' : ''}`}>
                <input type="radio" name="setup-mic" checked={(chosen || (devices.length === 1 ? d : '')) === d} onChange={() => pick(d)} />
                <span className="grow">
                  <b>{d}</b>
                  <small className="muted"> {level > 0.03 ? 'hears you clearly' : level > 0.003 ? 'hears you, quietly' : 'silent — is it muted?'}</small>
                </span>
                <LevelBars level={level} cells={16} label={d} />
              </label>
            );
          })}
        </div>
        {error && <p className="warn mb-0">{error}</p>}
      </section>
      <p className="small muted">
        Too quiet or crackling? Aim for the black zone; hitting pink often means clipping. Lower the input volume in your system
        sound settings to around 60%.
      </p>
      <p className="small">
        No pop-up appeared, or you clicked Don't allow?{' '}
        <button type="button" className="link-btn" onClick={blocked}>
          Fix microphone access
        </button>
      </p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!chosen && loudest) pick(loudest);
            next();
          }}
        >
          Use {chosen || loudest || 'the default microphone'} →
        </button>
      </div>
    </section>
  );
}

function MicBlocked({ back, next }: { back: () => void; next: () => void }): React.JSX.Element {
  const os = useMemo<'macos' | 'windows' | 'linux'>(() => {
    const p = navigator.userAgent;
    return /Mac/i.test(p) ? 'macos' : /Win/i.test(p) ? 'windows' : 'linux';
  }, []);
  const [tab, setTab] = useState(os);
  const [state, setState] = useState<string>('denied');
  // "This screen notices by itself": poll the permission.
  useEffect(() => {
    const t = setInterval(() => void queryMicrophonePermission().then(setState).catch(() => undefined), 1500);
    return () => clearInterval(t);
  }, []);
  const steps = {
    macos: ['Open System Settings › Privacy & Security › Microphone.', 'Turn on Local Transcribe in the list.', 'Come back here. You may need to quit and reopen the app once.'],
    windows: ['Open Settings › Privacy & security › Microphone.', 'Turn on "Let desktop apps access your microphone".', 'Come back here.'],
    linux: ['Open your sound settings (or pavucontrol › Recording).', 'Unmute the input and pick the right device.', 'Come back here and check again.'],
  }[tab];
  return (
    <section>
      <StepHead
        kicker="Step 2 of 6 · Microphone blocked"
        title="The mic is blocked."
        lede="The system said no to the microphone — usually a quick “Don't allow”. Nothing is broken. A few clicks turn it back on, and this screen notices by itself."
      />
      <section className="card" aria-label="How to allow the microphone">
        <div className="card-title">
          <strong>Allow the microphone</strong>
        </div>
        <div className="tabs" role="group" aria-label="Operating system">
          {(['macos', 'windows', 'linux'] as const).map((t) => (
            <button key={t} type="button" className={`tab${tab === t ? ' active' : ''}`} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t === 'macos' ? 'macOS' : t === 'windows' ? 'Windows' : 'Linux'}
            </button>
          ))}
        </div>
        <ol className="fix-steps">
          {steps.map((s, i) => (
            <li key={s}>
              <span className="wrap-n">{i + 1}</span> {s}
              {i === 0 && isDesktopApp() && (
                <button type="button" className="btn btn-sm" onClick={() => void openPrivacySettings().catch(() => undefined)}>
                  Open it for me
                </button>
              )}
            </li>
          ))}
        </ol>
        <p className="small" role="status">
          {state === 'granted' ? '[x] Access allowed — continue.' : 'Watching for access…'}
        </p>
      </section>
      <p className="small muted">
        No mic at all? You can still record what this computer plays and import audio files. The mic can be added later in
        Settings › Recording.
      </p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <button type="button" className="btn" onClick={next}>
          Continue without a mic
        </button>
        <button type="button" className="btn btn-primary" onClick={back}>
          Check again
        </button>
      </div>
    </section>
  );
}

function CallsStep({ back, next }: { back: () => void; next: () => void }): React.JSX.Element {
  const { nativeRecording, systemAudio } = useApp();
  const [calls, setCalls] = useState(defaultSource() !== 'speaker');
  const [consent, setConsent] = useState(recordingPrefs().consentReminder);
  const [testing, setTesting] = useState(false);
  const [heard, setHeard] = useState<boolean | null>(null);
  const supported = !!nativeRecording?.systemAudio || !!systemAudio?.available;
  const { levels } = useLevelMonitor([{ role: 'device' }], calls && supported && isDesktopApp());
  const peak = useRef(0);
  useEffect(() => {
    if (testing) peak.current = Math.max(peak.current, levels[0] ?? 0);
  }, [levels, testing]);

  const playTone = (): void => {
    const ctx = playbackContext();
    void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    peak.current = 0;
    setHeard(null);
    setTesting(true);
    osc.start();
    setTimeout(() => {
      osc.stop();
      osc.disconnect();
      gain.disconnect();
      setTimeout(() => {
        setTesting(false);
        setHeard(peak.current > 0.01);
      }, 600);
    }, 1200);
  };

  return (
    <section>
      <StepHead kicker="Step 3 of 6 · Calls & computer audio" title="Do you record calls?" />
      <div className="source-grid two">
        <label className={`source-card${calls ? ' selected' : ''}`}>
          <span className="source-head">
            Yes, calls too <input type="radio" name="calls" checked={calls} onChange={() => setCalls(true)} />
          </span>
          <small>Zoom, Meet, Teams. We record your mic and the call together, no screen sharing.</small>
        </label>
        <label className={`source-card${!calls ? ' selected' : ''}`}>
          <span className="source-head">
            Just rooms <input type="radio" name="calls" checked={!calls} onChange={() => setCalls(false)} />
          </span>
          <small>Only the microphone. You can turn calls on later.</small>
        </label>
      </div>
      {calls && (
        <section className="card mt-4" aria-label="Computer audio check">
          <div className="card-title">
            <strong>Computer audio</strong>
          </div>
          <div className="check-line">
            <span className="mark">{supported ? '[x]' : '[!]'}</span>
            <span>
              <b>{supported ? 'Audio capture available' : 'No direct computer-audio capture here'}</b>
              <br />
              <small className="muted">
                {supported
                  ? 'Records what the computer plays (Windows loopback, macOS 14.2+ audio tap, PipeWire/PulseAudio monitor) — nothing on screen is captured.'
                  : 'Calls are recorded through a shared tab or window instead.'}
              </small>
            </span>
          </div>
          {supported && isDesktopApp() && (
            <div className="check-line">
              <span className="mark">{heard ? '[x]' : heard === false ? '[!]' : '[ ]'}</span>
              <span className="grow">
                <b>{heard ? 'Test sound heard' : heard === false ? 'Test sound not heard' : 'Test sound'}</b>
                <br />
                <small className="muted">
                  {heard === false
                    ? 'Check the output device in Settings › Recording (Record sound from), then play again.'
                    : 'We play a short tone through your speakers and listen for it.'}
                </small>
              </span>
              <LevelBars level={levels[0] ?? 0} cells={14} label="Computer audio level" />
              <button type="button" className="btn btn-sm" disabled={testing} onClick={playTone}>
                {testing ? 'Playing…' : heard === null ? 'Play test sound' : 'Play again'}
              </button>
            </div>
          )}
        </section>
      )}
      <label className="check-row">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          <b>Remind me to tell people they're being recorded.</b>{' '}
          <small className="muted">A short line appears when a call recording starts. Many places require everyone's consent.</small>
        </span>
      </label>
      <div className="btn-row">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setDefaultSource(calls ? 'dual' : 'speaker');
            setRecordingPrefs({ consentReminder: consent });
            next();
          }}
        >
          Continue →
        </button>
      </div>
    </section>
  );
}

interface Rec {
  model: CatalogModel;
  ok: boolean;
  why: string;
}

/** Recommend models for the languages and the machine: English-only ones only for English. */
export function recommend(catalog: CatalogModel[], languages: string[], info: SystemInfo | null, hasGpu = false): Rec[] {
  const nonEnglish = languages.some((l) => l !== 'en');
  const memGb = (info?.memoryBytes ?? 8e9) / 1e9;
  const englishOnly = (m: CatalogModel) => /\.en\b|parakeet/i.test(m.id);
  const rank = (m: CatalogModel) => ({ S: 0, A: 1, B: 2, C: 3, D: 4 })[m.tier] ?? 5;
  const ordered = [...catalog].sort((a, b) => rank(a) - rank(b));
  const best = hasGpu || memGb >= 8 ? ordered : ordered.filter((m) => m.tier !== 'S');
  const pick: CatalogModel[] = [];
  for (const tier of ['S', 'A', 'B'] as const) {
    const m = best.find((x) => x.tier === tier && !pick.includes(x) && (!nonEnglish || !englishOnly(x)));
    if (m) pick.push(m);
  }
  const eng = ordered.find((m) => englishOnly(m) && m.tier !== 'D');
  if (eng && !pick.includes(eng)) pick.push(eng);
  return pick.map((m) => {
    const off = nonEnglish && englishOnly(m);
    const why = off
      ? 'English only — would skip your other languages'
      : m.tier === 'S'
        ? `Most accurate${hasGpu ? ' · quick on your GPU' : ''}`
        : m.tier === 'A'
          ? 'Good accuracy · lighter on battery'
          : 'Fastest on older laptops';
    return { model: m, ok: !off, why: m.installed ? `${why} · downloaded` : why };
  });
}

function ModelStep({ back, next }: { back: () => void; next: () => void }): React.JSX.Element {
  const { modelCatalog, nativeStatus, downloadModel, setLanguage, selectModel } = useApp();
  const [langs, setLangs] = useState<string[]>(() => (meetingLanguages().length ? meetingLanguages() : ['en']));
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [other, setOther] = useState('');
  useEffect(() => {
    if (isDesktopApp()) void systemInfo().then(setInfo).catch(() => undefined);
  }, []);
  const gpu = !!nativeStatus?.gpu?.active || /metal|cuda|vulkan/i.test(nativeStatus?.acceleration ?? '');
  const recs = recommend(modelCatalog, langs, info, gpu);
  const chosen = recs.find((r) => r.model.id === pick && r.ok) ?? recs.find((r) => r.ok);
  const toggle = (code: string): void => setLangs((l) => (l.includes(code) ? l.filter((x) => x !== code) : [...l, code]));
  return (
    <section>
      <StepHead kicker="Step 4 of 6 · Speech model" title="What language are your meetings?" />
      <div className="chip-row" role="group" aria-label="Meeting languages">
        {LANGS.map(([code, name]) => (
          <button key={code} type="button" className="chip" aria-pressed={langs.includes(code)} onClick={() => toggle(code)}>
            {langs.includes(code) ? '[x] ' : ''}
            {name}
          </button>
        ))}
        <input className="input input-sm" aria-label="Other language code" placeholder="+ Other (code)" value={other} onChange={(e) => setOther(e.target.value.toLowerCase().slice(0, 3))} onBlur={() => other && !langs.includes(other) && setLangs([...langs, other])} />
      </div>
      <div className="row wrap facts">
        <span className="pill">{gpu ? `[x] GPU · ${describeGpu(nativeStatus?.gpu) || nativeStatus?.acceleration}` : '[ ] no GPU acceleration'}</span>
        {info?.memoryBytes && <span className="pill">[x] {Math.round(info.memoryBytes / 1e9)} GB memory</span>}
        {info?.freeDiskBytes && <span className="pill">[x] {formatBytes(info.freeDiskBytes)} free</span>}
      </div>
      <section className="card mt-4" aria-label="Recommended model">
        <div className="card-title">
          <strong>
            Recommended for you because: {langs.length > 1 ? `${langs.length} languages` : langs[0] === 'en' ? 'English' : '1 language'}
            {gpu ? ' + GPU' : ''}
          </strong>
        </div>
        <div className="model-picks">
          {recs.map((r) => (
            <label key={r.model.id} className={`model-pick${chosen?.model.id === r.model.id ? ' selected' : ''}${r.ok ? '' : ' off'}`}>
              <input type="radio" name="setup-model" disabled={!r.ok} checked={chosen?.model.id === r.model.id} onChange={() => setPick(r.model.id)} />
              <span className={`tier-badge tier-${r.model.tier}`}>{r.model.tier}</span>
              <span className="grow">
                <b>{r.model.label}</b>
                <small className="muted"> {r.why}</small>
              </span>
              <span className="small">{formatBytes(r.model.sizeBytes)}</span>
            </label>
          ))}
          {recs.length === 0 && <p className="muted pad">No transcription engine was found — recording still works. Settings › Engine & models has the details.</p>}
        </div>
      </section>
      <div className="btn-row">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <span className="small self-center">Downloads in the background while you try it.</span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setMeetingLanguages(langs);
            void setLanguage(langs.length === 1 ? langs[0]! : 'auto');
            if (chosen) {
              if (chosen.model.installed) void selectModel(chosen.model.id);
              else void downloadModel(chosen.model.id).catch(() => undefined);
            }
            next();
          }}
        >
          {chosen && !chosen.model.installed ? `Download ${formatBytes(chosen.model.sizeBytes)} →` : 'Continue →'}
        </button>
      </div>
    </section>
  );
}

function TryStep({ back, next }: { back: () => void; next: () => void }): React.JSX.Element {
  const { installedModels, modelDownload, language } = useApp();
  const [state, setState] = useState<'idle' | 'rec' | 'tx' | 'done' | 'error'>('idle');
  const [left, setLeft] = useState(5);
  const [result, setResult] = useState<{ text: string; ms: number; words: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The smallest installed model: a quick draft (the full model is more accurate).
  const model = [...installedModels].sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity))[0];
  const record = async (): Promise<void> => {
    if (!model) return;
    setError(null);
    setResult(null);
    setState('rec');
    const chunks: Float32Array[] = [];
    const mic = new MicrophoneAudioSource();
    const tap = new LivePcmTap((s) => chunks.push(s));
    try {
      const stream = await mic.start();
      await tap.start(stream);
      for (let s = 5; s > 0; s--) {
        setLeft(s);
        await new Promise((r) => setTimeout(r, 1000));
      }
      await tap.stop();
      await mic.stop();
      setState('tx');
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const audio = new Float32Array(total);
      let at = 0;
      for (const c of chunks) {
        audio.set(c, at);
        at += c.length;
      }
      const t0 = performance.now();
      const segs = await invokeDesktop<NativeSegment[]>('native_live_transcribe', {
        request: liveRequest(model.id, encodeWav16(audio, 16000), language),
      });
      const text = segs.map((s) => s.text.trim()).join(' ').trim();
      const want = TEST_SENTENCE.toLowerCase().match(/[a-z]+/g) ?? [];
      const got = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
      setResult({ text: text || '(nothing heard)', ms: performance.now() - t0, words: want.filter((w) => got.has(w)).length });
      setState('done');
    } catch (e) {
      await tap.stop().catch(() => undefined);
      await mic.stop().catch(() => undefined);
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  };
  const words = TEST_SENTENCE.split(' ').length;
  return (
    <section>
      <StepHead kicker="Step 5 of 6 · Try it" title="Say it. See it." lede="A five-second test, transcribed on this computer. It's thrown away afterwards — nothing is saved." />
      <section className="card try-card" aria-live="polite" aria-label="Test recording">
        {!model ? (
          <>
            <p className="mt-0">The speech model is still downloading — the test needs it.</p>
            <ModelDownloadProgress />
            {!modelDownload && <p className="muted small mb-0">No model is installed yet. Skip the test; transcription works once a model is downloaded.</p>}
          </>
        ) : state === 'idle' || state === 'error' ? (
          <>
            <span className="kicker">Read this out loud</span>
            <p className="try-sentence">“{TEST_SENTENCE}”</p>
            <button type="button" className="btn btn-hero" disabled={!isDesktopApp()} onClick={() => void record()}>
              ● Record 5 seconds
            </button>
            {error && <p className="warn">{error}</p>}
          </>
        ) : state === 'rec' ? (
          <p className="try-rec">
            <span className="lamp" aria-hidden="true" /> Recording — keep talking · {left}
          </p>
        ) : state === 'tx' ? (
          <div className="loader-head">
            <span className="spinner" aria-hidden="true" />
            <strong>Transcribing on this computer · {model.label}</strong>
          </div>
        ) : (
          result && (
            <>
              <span className="kicker">Here's what it heard</span>
              <ul className="transcript flat">
                <li>
                  <span className="ts">{formatClock(1)}</span>
                  {result.text}
                </li>
              </ul>
              <p className="small">
                <span className="mark">{result.words >= words - 1 ? '[x]' : '[~]'}</span> {result.words} of {words} words · Took{' '}
                {(result.ms / 1000).toFixed(1)} s · the full model will be even more accurate{' '}
                <button type="button" className="btn btn-sm" onClick={() => setState('idle')}>
                  Try again
                </button>
              </p>
            </>
          )
        )}
      </section>
      <div className="btn-row">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <button type="button" className="btn" onClick={next}>
          Skip test
        </button>
        <button type="button" className="btn btn-primary" disabled={state !== 'done'} onClick={next}>
          Sounds right →
        </button>
      </div>
    </section>
  );
}

function FilesStep({ back, next }: { back: () => void; next: () => void }): React.JSX.Element {
  const { storageDir, go, gitlabConfig, calendarConfig, llmConfig } = useApp();
  const [guide, setGuide] = useState(wrapPrefs().guide);
  const [auto, setAuto] = useState(autoTranscribeEnabled());
  const [keep, setKeep] = useState<KeepAudio>(keepAudio());
  const [folder, setFolder] = useState(storageDir);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setFolder(storageDir), [storageDir]);
  const save = (): void => {
    setWrapPrefs({ guide });
    setAutoTranscribeEnabled(auto);
    setKeepAudio(keep);
  };
  return (
    <section>
      <StepHead kicker="Step 6 of 6 · Your files & what happens after" title="When you press stop" />
      <section className="card" aria-label="After a recording">
        <div className="card-title">
          <strong>After a recording</strong>
        </div>
        <label className="check-row mt-0">
          <input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} />
          <span>
            <b>Guide me through the wrap-up</b> <small className="muted">One step at a time, each skippable. The same steps stay as tabs in the meeting.</small>
          </span>
        </label>
        <ol className="chain" aria-label="Wrap-up steps">
          {['Transcribe', 'Review summary', 'GitLab issues', 'Calendar events', 'Export'].map((s, i) => (
            <li key={s}>
              <span className="wrap-n">{i + 1}</span> {s}
            </li>
          ))}
        </ol>
        <label className="check-row">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            <b>Transcribe as soon as it stops</b> <small className="muted">Runs in the background.</small>
          </span>
        </label>
        <span className="field-label">Keep the audio after transcribing</span>
        <div className="seg-control" role="radiogroup" aria-label="Keep audio">
          {(
            [
              ['always', 'Always'],
              ['30d', '30 days'],
              ['exported', 'Until exported'],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className={keep === v ? 'on' : undefined}>
              <input type="radio" name="keep" checked={keep === v} onChange={() => setKeep(v)} />
              {l}
            </label>
          ))}
        </div>
      </section>
      <section className="card" aria-label="Folder">
        <div className="card-title">
          <strong>Folder</strong>
        </div>
        <code className="block">{folder ?? 'Browser storage (desktop app: Documents/Local Transcribe)'}</code>
        <p className="small muted">Audio, transcript.md and meeting.json for each meeting.</p>
        {isDesktopApp() && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              void pickFolder('Where should meetings be saved?')
                .then((p) => (p ? setStorageDir(p, true).then(setFolder) : null))
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            Change…
          </button>
        )}
        {error && <p className="warn">{error}</p>}
      </section>
      <section className="card" aria-label="Used by the wrap-up">
        <div className="card-title">
          <strong>Used by the wrap-up · optional</strong>
        </div>
        <div className="check-line">
          <span className="grow">
            <b>GitLab</b> {gitlabConfig.token ? <small className="muted">connected</small> : null}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => { save(); go({ name: 'settings', tab: 'integrations' }); }}>
            {gitlabConfig.token ? 'Change' : 'Connect'}
          </button>
        </div>
        <div className="check-line">
          <span className="grow">
            <b>Calendar (CalDAV, Exchange)</b> {calendarConfig.serverUrl ? <small className="muted">set up</small> : null}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => { save(); go({ name: 'settings', tab: 'integrations' }); }}>
            {calendarConfig.serverUrl ? 'Change' : 'Connect'}
          </button>
        </div>
        <div className="check-line">
          <span className="grow">
            <b>Summaries · Ollama, Claude or OpenCode</b> <small className="muted">{llmConfig.model ? llmConfig.model : ''}</small>
          </span>
          <button type="button" className="btn btn-sm" onClick={() => { save(); go({ name: 'settings', tab: 'summaries' }); }}>
            Choose
          </button>
        </div>
      </section>
      <div className="btn-row">
        <button type="button" className="btn" onClick={back}>
          ← Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            save();
            next();
          }}
        >
          Finish →
        </button>
      </div>
    </section>
  );
}

function SetupDone(): React.JSX.Element {
  const { go, modelMeta } = useApp();
  const keys = useShortcuts();
  const quickRecord = useQuickRecord();
  const mic = getMicrophoneDevice()?.label || 'Default microphone';
  const calls = defaultSource() !== 'speaker';
  const langs = meetingLanguages();
  return (
    <div className="setup-done">
      <h1 className="hero-title">Ready.</h1>
      <section className="card" aria-label="What you set up">
        <div className="card-title">
          <strong>You're set up with</strong>
        </div>
        <ul className="promises">
          <li>
            <span className="mark">[x]</span> {mic}
          </li>
          <li>
            <span className="mark">[x]</span> {calls ? 'Calls: mic + computer audio' : 'Rooms: microphone only'}
          </li>
          <li>
            <span className="mark">[x]</span> {modelMeta.modelId}
            {langs.length ? ` · ${langs.map((l) => LANGS.find((x) => x[0] === l)?.[1] ?? l).join(', ')}` : ''}
          </li>
          <li>
            <span className="mark">{wrapPrefs().guide ? '[x]' : '[ ]'}</span> Guided wrap-up after each recording
          </li>
        </ul>
      </section>
      <p>
        Your first recording is one key away. When you press stop, the app transcribes it and walks you through issues, events
        and export — one step at a time.
      </p>
      <div className="kbd-grid" aria-label="Keyboard shortcuts">
        <span>
          <Keys binding={keys.record} /> Record
        </span>
        <span>
          <Keys binding={keys.pause} /> Pause
        </span>
        <span>
          <Keys binding={keys.moment} /> Mark moment
        </span>
        <span>
          <Keys binding={keys.play} /> Play / pause
        </span>
        <span>
          <Keys binding={keys.search} /> Search all
        </span>
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-hero"
          onClick={() => {
            setSetupDone(true);
            void quickRecord();
          }}
        >
          ● Record your first meeting
        </button>
        <button type="button" className="btn" onClick={() => finish(go)}>
          Go to Home
        </button>
      </div>
    </div>
  );
}
