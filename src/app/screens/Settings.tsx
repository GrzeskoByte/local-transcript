import { useEffect, useState } from 'react';
import { useApp } from '../store.tsx';
import { groupByTier, type CatalogModel } from '../../asr/model-tiers';
import {
  NATIVE_LANGUAGE_OPTIONS,
  nativeAccuracyHint,
  describeNativeRuntime,
  describeGpu,
} from '../../asr/model-manager';
import { CheckIcon, GearIcon } from '../components/icons.tsx';
import { GITLAB_TARGET_LABELS, createGitlabClient } from '../../integrations/gitlab';
import type { GitlabTarget } from '../../integrations/gitlab';
import {
  isSecureMediaContext,
  primeMicrophonePermission,
  queryMicrophonePermission,
  type MediaAccessFailure,
} from '../../audio/permissions';

/** Tiers expanded by default; the rest stay collapsed to keep this scannable. */
const OPEN_TIERS = new Set(['S', 'A']);

export function Settings(): React.JSX.Element {
  const {
    go,
    nativeStatus,
    modelMeta,
    modelCatalog,
    installedModels,
    downloadModel,
    selectModel,
    language,
    setLanguage,
    enableGpu,
    saveToDisk,
    setSaveToDisk,
    storageDir,
    openStorageDir,
    gitlabConfig,
    saveGitlabConfig,
  } = useApp();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [gpuBusy, setGpuBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micPermission, setMicPermission] = useState<
    'granted' | 'denied' | 'prompt' | 'unknown' | null
  >(null);
  const [micBusy, setMicBusy] = useState(false);
  const [micFailure, setMicFailure] = useState<MediaAccessFailure | null>(null);
  const [gitlabDraft, setGitlabDraft] = useState(gitlabConfig);
  const [gitlabBusy, setGitlabBusy] = useState(false);
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null);

  const secure = isSecureMediaContext();

  useEffect(() => {
    if (!secure) return;
    void queryMicrophonePermission()
      .then(setMicPermission)
      .catch(() => setMicPermission('unknown'));
  }, [secure]);

  const gpu = nativeStatus?.gpu ?? null;
  const groups = groupByTier(modelCatalog);
  const languageOptions = NATIVE_LANGUAGE_OPTIONS;
  const parakeetUsable = modelCatalog.some(
    (m) => /^parakeet/i.test(m.id) && (m.installed || m.downloadable),
  );
  const hint = nativeAccuracyHint(modelMeta.modelId, { parakeet: parakeetUsable });
  const downloadingId =
    modelMeta.state === 'downloading' || modelMeta.state === 'verifying'
      ? modelMeta.modelId
      : null;

  const run = async (m: CatalogModel, action: 'use' | 'download'): Promise<void> => {
    setBusyId(m.id);
    setError(null);
    try {
      if (action === 'download') await downloadModel(m.id);
      else await selectModel(m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const enableGpuNow = async (): Promise<void> => {
    setGpuBusy(true);
    setError(null);
    try {
      await enableGpu();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGpuBusy(false);
    }
  };

  const grantMicNow = async (): Promise<void> => {
    setMicBusy(true);
    setMicFailure(null);
    try {
      const failure = await primeMicrophonePermission();
      if (failure) setMicFailure(failure);
      setMicPermission(await queryMicrophonePermission());
    } finally {
      setMicBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Models and language. Everything runs on this device.</p>
        </div>
        <button className="btn" onClick={() => go({ name: 'dashboard' })}>
          Done
        </button>
      </div>

      <section className="card" aria-label="Engine">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="media-art" style={{ width: 36, height: 36 }}>
            <GearIcon />
          </span>
          <div style={{ flex: 1 }}>
            <strong>Desktop engine</strong>
            <div className="muted" aria-label="Acceleration">
              {describeNativeRuntime(nativeStatus)}
            </div>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Native models live on disk and are shared with your system CLI. Only installed
          models appear in the transcription options.
        </p>
      </section>

      <section className="card" aria-label="Microphone access">
        <div className="model-title" style={{ marginBottom: 4 }}>
          <strong>Microphone access</strong>
          {micPermission === 'granted' && (
            <span className="badge badge-ok">
              <CheckIcon /> Granted
            </span>
          )}
        </div>
        <div className="muted" aria-label="Microphone permission">
          {!secure
            ? 'Unavailable in this context — audio capture needs a secure context.'
            : micPermission === 'granted'
              ? 'The app already has microphone access.'
              : micPermission === 'denied'
                ? 'Access is blocked. Allow the microphone for this app in your system privacy settings.'
                : 'Grant access now so the permission prompt appears before you start a recording.'}
        </div>
        {secure && micPermission !== 'granted' && (
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" disabled={micBusy} onClick={() => void grantMicNow()}>
              {micBusy ? 'Requesting…' : 'Grant microphone access'}
            </button>
          </div>
        )}
        {micFailure && (
          <p className="warn" style={{ marginTop: 10, marginBottom: 0 }} role="alert">
            {micFailure.message} {micFailure.hint}
          </p>
        )}
      </section>

      <section className="card" aria-label="Local files">
        <div className="model-title" style={{ marginBottom: 4 }}>
          <strong>Local files</strong>
          {saveToDisk && <span className="badge badge-ok">Saving</span>}
        </div>
        <div className="muted">
          {storageDir ? (
            <>
              Finished meetings are copied to <code>{storageDir}</code> — audio, transcript and
              a JSON manifest.
            </>
          ) : (
            'Locating the local storage folder…'
          )}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={saveToDisk}
            onChange={(e) => setSaveToDisk(e.target.checked)}
          />
          Save recordings and transcripts to disk automatically
        </label>
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void openStorageDir()}>
            Open folder
          </button>
        </div>
      </section>

      <section className="card" aria-label="GitLab team sharing">
        <div className="model-title" style={{ marginBottom: 4 }}>
          <strong>GitLab team sharing</strong>
        </div>
        <div className="muted">
          Publish transcripts to a GitLab project as a wiki page, issue, or repository file.
          Your team sees them through normal GitLab project membership — no account here.
        </div>
        <label className="field-label" htmlFor="gitlab-url">Instance URL</label>
        <input
          id="gitlab-url"
          className="input"
          value={gitlabDraft.url}
          onChange={(e) => setGitlabDraft({ ...gitlabDraft, url: e.target.value })}
          placeholder="https://gitlab.com"
          inputMode="url"
        />
        <label className="field-label" htmlFor="gitlab-project">Project path</label>
        <input
          id="gitlab-project"
          className="input"
          value={gitlabDraft.project}
          onChange={(e) => setGitlabDraft({ ...gitlabDraft, project: e.target.value })}
          placeholder="my-group/my-project"
        />
        <label className="field-label" htmlFor="gitlab-token">Personal access token</label>
        <input
          id="gitlab-token"
          className="input"
          type="password"
          value={gitlabDraft.token}
          onChange={(e) => setGitlabDraft({ ...gitlabDraft, token: e.target.value })}
          placeholder="glpat-… (api scope)"
          autoComplete="off"
        />
        <div className="row-selects">
          <label>
            Publish as
            <select
              className="input"
              aria-label="GitLab target"
              value={gitlabDraft.target}
              onChange={(e) =>
                setGitlabDraft({ ...gitlabDraft, target: e.target.value as GitlabTarget })
              }
            >
              {(Object.keys(GITLAB_TARGET_LABELS) as GitlabTarget[]).map((t) => (
                <option key={t} value={t}>{GITLAB_TARGET_LABELS[t]}</option>
              ))}
            </select>
          </label>
          {gitlabDraft.target === 'file' && (
            <label>
              Branch
              <input
                className="input"
                aria-label="GitLab branch"
                value={gitlabDraft.branch}
                onChange={(e) => setGitlabDraft({ ...gitlabDraft, branch: e.target.value })}
                placeholder="main"
              />
            </label>
          )}
        </div>
        {gitlabMessage && <p className="muted small" style={{ marginBottom: 0 }}>{gitlabMessage}</p>}
        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={gitlabBusy}
            onClick={() => {
              setGitlabBusy(true);
              setGitlabMessage(null);
              saveGitlabConfig(gitlabDraft)
                .then(() => setGitlabMessage('GitLab settings saved on this device.'))
                .catch((e: unknown) =>
                  setGitlabMessage(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setGitlabBusy(false));
            }}
          >
            {gitlabBusy ? 'Saving…' : 'Save GitLab settings'}
          </button>
          <button
            className="btn"
            disabled={gitlabBusy}
            onClick={() => {
              setGitlabBusy(true);
              setGitlabMessage(null);
              createGitlabClient(gitlabDraft)
                .testConnection()
                .then((r) => setGitlabMessage(`Connected as ${r.username} → ${r.project}.`))
                .catch((e: unknown) =>
                  setGitlabMessage(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setGitlabBusy(false));
            }}
          >
            Test connection
          </button>
        </div>
      </section>

      <section className="card" aria-label="GPU acceleration">
        <div className="model-title" style={{ marginBottom: 4 }}>
          <strong>GPU acceleration</strong>
          {gpu?.active && <span className="badge badge-ok">Active</span>}
        </div>
        <div className="muted" aria-label="GPU status">
          {describeGpu(gpu)}
        </div>
        {gpu && gpu.available && !gpu.active && (
          <div
            style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <button className="btn btn-primary" disabled={gpuBusy} onClick={() => void enableGpuNow()}>
              {gpuBusy ? 'Enabling…' : 'Enable GPU acceleration'}
            </button>
            <span className="muted small">May ask for your password (polkit / sudo).</span>
          </div>
        )}
        {gpu && gpu.hint && !gpu.active && (
          <p className="muted small" style={{ marginBottom: 0, marginTop: 8 }}>
            Or run: <code>{gpu.hint}</code>
          </p>
        )}
      </section>

      <section className="card" aria-label="Language">
        <label className="field-label" htmlFor="settings-language">
          Spoken language
        </label>
        <select
          id="settings-language"
          className="input"
          aria-label="Spoken language"
          value={language}
          onChange={(e) => void setLanguage(e.target.value)}
        >
          {languageOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="muted" style={{ marginBottom: 0 }}>
          Native whisper.cpp can auto-detect the language.
        </p>
      </section>

      <h2>Models</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Tiered from best (S) to fastest (D). Download the tier you need; only downloaded
        models show up when you transcribe.
      </p>
      {hint && (
        <p className="muted" style={{ marginTop: 0 }} aria-label="Accuracy tip">
          {hint}
        </p>
      )}

      {groups.length === 0 && (
        <section className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            {nativeStatus?.installHint ??
              'No desktop transcription engine found. Install whisper.cpp or voxtype.'}
          </p>
        </section>
      )}

      {error && <div className="error">{error}</div>}

      {groups.map(({ tier, models }) => {
        const body = (
          <ul className="model-list" aria-label={`Tier ${tier.id} models`}>
            {models.map((m) => {
              const active = m.id === modelMeta.modelId;
              const busy = busyId === m.id;
              const progress = downloadingId === m.id ? modelMeta.progress : null;
              return (
                <li key={m.id} className={`model-row${active ? ' active' : ''}`}>
                  <div className="model-main">
                    <div className="model-title">
                      <span className="model-name">{m.label}</span>
                      {m.recommended && <span className="badge badge-rec">Recommended</span>}
                      {m.installed && (
                        <span className="badge badge-ok">
                          <CheckIcon /> Installed
                        </span>
                      )}
                      {active && <span className="badge badge-active">Active</span>}
                    </div>
                    <div className="muted small">
                      {m.engine}
                      {m.detail ? ` · ${m.detail}` : ''}
                    </div>
                  </div>
                  <div className="model-actions">
                    {progress !== null ? (
                      <span className="muted">{Math.round(progress * 100)}%</span>
                    ) : m.installed ? (
                      <button
                        className="btn"
                        disabled={active || busy}
                        onClick={() => void run(m, 'use')}
                      >
                        {active ? 'In use' : busy ? '…' : 'Use'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        disabled={busy || !m.downloadable}
                        onClick={() => void run(m, 'download')}
                      >
                        {!m.downloadable ? 'Unavailable' : busy ? 'Starting…' : 'Download'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        );

        return OPEN_TIERS.has(tier.id) ? (
          <section className="card tier-card" key={tier.id}>
            <div className="tier-head">
              <span className={`tier-badge tier-${tier.id}`}>{tier.id}</span>
              <div>
                <strong>{tier.label}</strong>
                <div className="muted small">{tier.blurb}</div>
              </div>
            </div>
            {body}
          </section>
        ) : (
          <details className="card tier-card" key={tier.id}>
            <summary className="tier-head">
              <span className={`tier-badge tier-${tier.id}`}>{tier.id}</span>
              <div>
                <strong>{tier.label}</strong>
                <div className="muted small">
                  {tier.blurb} ({models.length})
                </div>
              </div>
            </summary>
            {body}
          </details>
        );
      })}

      {installedModels.length > 0 && (
        <p className="muted">
          Ready to transcribe with: {installedModels.map((m) => m.label).join(', ')}.
        </p>
      )}
    </>
  );
}
