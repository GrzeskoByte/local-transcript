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
import { GITLAB_TARGET_LABELS, createGitlabClient, parseProjectUrl } from '../../integrations/gitlab';
import type { GitlabTarget } from '../../integrations/gitlab';
import {
  LLM_PRESETS,
  LLM_PRESET_LABELS,
  createLlmClient,
  getClaudeStatus,
  getOpencodeStatus,
  isLocalAgentPreset,
} from '../../integrations/llm';
import type { LlmPreset } from '../../integrations/llm';
import {
  CALENDAR_PROVIDER_LABELS,
  sogoCalendarUrl,
  testCalendarConnection,
  validateCalendarConfig,
} from '../../integrations/calendar';
import type { CalendarProvider } from '../../integrations/calendar';
import {
  CALENDAR_SYSTEM_LABELS,
  detectFromServer,
  scanThunderbird,
  type DetectedCalendar,
  type MailAccount,
} from '../../integrations/calendar-detect';
import { isDesktopApp, openExternalUrl } from '../../platform/desktop';
import { AudioDevicePickers } from '../components/AudioDevices.tsx';
import {
  getAutoCheck,
  getUpdateProgress,
  installUpdate,
  setAutoCheck,
  updateBlockedReason,
  updateRatio,
  type UpdateProgress,
} from '../../platform/updater';
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
    calendarConfig,
    saveCalendarConfig,
    llmConfig,
    saveLlmConfig,
    route,
    recordingState,
    txStage,
    updateInfo,
    checkUpdates,
    systemAudio,
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
  const [calDraft, setCalDraft] = useState(calendarConfig);
  const [calBusy, setCalBusy] = useState(false);
  const [calMessage, setCalMessage] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedCalendar[] | null>(null);
  const [mailAccounts, setMailAccounts] = useState<MailAccount[]>([]);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectMessage, setDetectMessage] = useState<string | null>(null);
  const [llmDraft, setLlmDraft] = useState(llmConfig);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  // Model list of a local agent CLI preset (OpenCode / Claude Code).
  const [agentModels, setAgentModels] = useState<string[] | null>(null);
  const [agentModelsError, setAgentModelsError] = useState<string | null>(null);

  const secure = isSecureMediaContext();

  useEffect(() => {
    if (!secure) return;
    void queryMicrophonePermission()
      .then(setMicPermission)
      .catch(() => setMicPermission('unknown'));
  }, [secure]);

  useEffect(() => {
    const preset = llmDraft.preset;
    if (!isLocalAgentPreset(preset)) {
      setAgentModels(null);
      setAgentModelsError(null);
      return;
    }
    const name = preset === 'claude' ? 'Claude Code' : 'OpenCode';
    if (!isDesktopApp()) {
      setAgentModels([]);
      setAgentModelsError(`The ${name} provider needs the desktop app.`);
      return;
    }
    setAgentModels(null);
    setAgentModelsError(null);
    const status = preset === 'claude' ? getClaudeStatus() : getOpencodeStatus();
    status
      .then((s) => {
        if (!s.available) {
          setAgentModels([]);
          setAgentModelsError(
            preset === 'claude'
              ? 'Claude Code CLI not found. Install it from claude.com/claude-code and run `claude` once to log in.'
              : 'OpenCode CLI not found. Install it from opencode.ai.',
          );
          return;
        }
        setAgentModels(s.models);
        if (s.models.length === 0) {
          setAgentModelsError('No OpenCode models reported. Check `opencode models`.');
        }
        const first = s.models[0];
        if (first) {
          setLlmDraft((d) => (d.preset === preset && !d.model.trim() ? { ...d, model: first } : d));
        }
      })
      .catch((e: unknown) => {
        setAgentModels([]);
        setAgentModelsError(e instanceof Error ? e.message : String(e));
      });
  }, [llmDraft.preset]);

  const [tab, setTab] = useState<'models' | 'calendar' | 'sharing' | 'ai' | 'app'>(
    route.name === 'settings' && route.tab ? route.tab : 'models',
  );
  useEffect(() => {
    if (route.name === 'settings' && route.tab) setTab(route.tab);
  }, [route]);
  const [autoCheck, setAutoCheckState] = useState(getAutoCheck);
  const [updateBusy, setUpdateBusy] = useState<'checking' | 'installing' | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const updateBlocked = updateBlockedReason(recordingState, Object.keys(txStage).length);

  const runUpdateCheck = () => {
    setUpdateBusy('checking');
    setUpdateMessage(null);
    checkUpdates()
      .then((info) =>
        setUpdateMessage(info.available ? null : `You're up to date (v${info.currentVersion}).`),
      )
      .catch((e: unknown) => setUpdateMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setUpdateBusy(null));
  };

  const runUpdateInstall = () => {
    setUpdateBusy('installing');
    setUpdateMessage(null);
    const poll = window.setInterval(() => {
      void getUpdateProgress().then(setUpdateProgress).catch(() => undefined);
    }, 400);
    // Resolves only on failure: success restarts the app.
    installUpdate()
      .catch((e: unknown) => setUpdateMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        window.clearInterval(poll);
        setUpdateBusy(null);
        setUpdateProgress(null);
      });
  };

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
      <div className="page-head tint-periwinkle">
        <div>
          <h1>Settings</h1>
          <p className="muted">Models, calendar, sharing, AI, and app preferences.</p>
        </div>
        <button className="btn" onClick={() => go({ name: 'dashboard' })}>
          Done
        </button>
      </div>

      <div className="tabs" role="tablist" aria-label="Settings sections">
        {(
          [
            ['models', 'Models'],
            ['calendar', 'Calendar'],
            ['sharing', 'Team sharing'],
            ['ai', 'AI assistant'],
            ['app', 'App'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'models' && (
      <>
      <section className="card" aria-label="Engine">
        <div className="media-row">
          <span className="media-art">
            <GearIcon />
          </span>
          <div className="grow">
            <strong>Desktop engine</strong>
            <div className="muted" aria-label="Acceleration">
              {describeNativeRuntime(nativeStatus)}
            </div>
          </div>
        </div>
        <p className="muted mb-0">
          Native models live on disk and are shared with your system CLI. Only installed
          models appear in the transcription options.
        </p>
      </section>
      </>
      )}

      {tab === 'app' && (
      <>
      <section className="card" aria-label="Updates">
        <div className="model-title">
          <strong>Updates</strong>
          {updateInfo && !updateInfo.available && (
            <span className="badge badge-ok">
              <CheckIcon /> Up to date
            </span>
          )}
        </div>
        {!isDesktopApp() ? (
          <div className="muted">Updates are installed from the desktop app.</div>
        ) : (
          <>
            <div className="muted">
              {updateInfo
                ? `Installed version: v${updateInfo.currentVersion}.`
                : 'Check GitHub for a newer version.'}{' '}
              Updates are signed and verified before installing; your recordings
              and transcripts are kept.
            </div>
            {updateInfo?.available && (
              <>
                <p className="mb-1">
                  <strong>Version {updateInfo.version} is available.</strong>
                </p>
                {updateInfo.notes && (
                  <p className="muted small pre-wrap mt-0">{updateInfo.notes}</p>
                )}
                {!updateInfo.canSelfUpdate && (
                  <p className="muted small">
                    This installation (.deb/.rpm) can't replace itself — download the new
                    version and install it the same way.
                  </p>
                )}
                {updateBlocked && updateInfo.canSelfUpdate && (
                  <p className="warn small" role="status">{updateBlocked}</p>
                )}
              </>
            )}
            {updateBusy === 'installing' && (
              <div className="mt-3" aria-label="Update progress">
                {updateProgress && updateRatio(updateProgress) !== null ? (
                  <progress max={1} value={updateRatio(updateProgress) ?? 0} />
                ) : (
                  <progress />
                )}
                <div className="muted small">
                  {updateProgress?.stage === 'installing'
                    ? 'Installing… the app restarts when done.'
                    : updateProgress?.stage === 'restarting'
                      ? 'Restarting…'
                      : 'Downloading update…'}
                </div>
              </div>
            )}
            {updateMessage && <p className="muted small mb-0" role="status">{updateMessage}</p>}
            <div className="btn-row">
              {updateInfo?.available && updateInfo.canSelfUpdate && (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!!updateBusy || !!updateBlocked}
                  onClick={runUpdateInstall}
                >
                  {updateBusy === 'installing' ? 'Updating…' : 'Update & restart'}
                </button>
              )}
              {updateInfo?.available && !updateInfo.canSelfUpdate && (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void openExternalUrl(updateInfo.downloadUrl)}
                >
                  Download v{updateInfo.version}
                </button>
              )}
              <button className="btn" type="button" disabled={!!updateBusy} onClick={runUpdateCheck}>
                {updateBusy === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
            <label className="check-row mt-3">
              <input
                type="checkbox"
                checked={autoCheck}
                onChange={(e) => {
                  setAutoCheck(e.target.checked);
                  setAutoCheckState(e.target.checked);
                }}
              />
              Check for updates when the app starts (contacts GitHub only)
            </label>
          </>
        )}
      </section>
      <section className="card" aria-label="Microphone access">
        <div className="model-title">
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
          <div className="mt-3">
            <button className="btn btn-primary" disabled={micBusy} onClick={() => void grantMicNow()}>
              {micBusy ? 'Requesting…' : 'Grant microphone access'}
            </button>
          </div>
        )}
        {micFailure && (
          <p className="warn mt-2 mb-0" role="alert">
            {micFailure.message} {micFailure.hint}
          </p>
        )}
      </section>

      <section className="card" aria-label="Audio devices">
        <div className="model-title">
          <strong>Audio devices</strong>
        </div>
        <div className="muted">
          Which microphone records you{systemAudio?.available ? ', which output Device Audio records,' : ''} and
          where recordings play. New Meeting uses the same choices; anything not connected falls back to the
          system default.
        </div>
        <AudioDevicePickers microphone systemOutput={systemAudio?.available === true} playback />
      </section>

      <section className="card" aria-label="Local files">
        <div className="model-title">
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
        <label className="check-row mt-3">
          <input
            type="checkbox"
            checked={saveToDisk}
            onChange={(e) => setSaveToDisk(e.target.checked)}
          />
          Save recordings and transcripts to disk automatically
        </label>
        <div className="mt-3">
          <button className="btn" onClick={() => void openStorageDir()}>
            Open folder
          </button>
        </div>
      </section>
      </>
      )}

      {tab === 'sharing' && (
      <>
      <section className="card" aria-label="GitLab team sharing">
        <div className="model-title">
          <strong>GitLab team sharing</strong>
        </div>
        <div className="muted">
          Publish transcripts to a GitLab project as a wiki page, issue, or repository file.
          Your team sees them through normal GitLab project membership — no account here.
          Paste a full project URL (works with self-hosted instances) or a bare
          <code>group/project</code> path.
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
        <label className="field-label" htmlFor="gitlab-project">Project path or URL</label>
        <input
          id="gitlab-project"
          className="input"
          value={gitlabDraft.project}
          onChange={(e) => {
            const raw = e.target.value;
            const parsed = parseProjectUrl(raw);
            setGitlabDraft({
              ...gitlabDraft,
              project: parsed.project || raw,
              url: parsed.url ?? gitlabDraft.url,
            });
          }}
          placeholder="my-group/my-project or https://git.example.com/my-group/my-project"
          inputMode="url"
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
        {gitlabMessage && <p className="muted small mb-0">{gitlabMessage}</p>}
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
      </>
      )}

      {tab === 'calendar' && (
      <>
      <section className="card" aria-label="Company calendar">
        <div className="model-title">
          <strong>Company calendar</strong>
        </div>
        <div className="muted">
          Create calendar events from a meeting summary on your company server.
          Credentials stay on this device; transport runs through the desktop shell.
        </div>
        <div className="btn-row">
          <button
            className="btn"
            type="button"
            disabled={detectBusy}
            onClick={() => {
              if (!isDesktopApp()) {
                setDetectMessage('Detection needs the desktop app.');
                return;
              }
              setDetectBusy(true);
              setDetectMessage(null);
              scanThunderbird()
                .then(({ calendars, mailAccounts: accounts }) => {
                  setDetected(calendars);
                  setMailAccounts(accounts);
                  setDetectMessage(
                    calendars.length
                      ? `Found ${calendars.length} calendar(s) in Thunderbird.`
                      : accounts.length
                        ? `No network calendar in Thunderbird; mail server ${accounts[0].host} found — try "Detect from server".`
                        : 'No Thunderbird profile with calendars found.',
                  );
                })
                .catch((e: unknown) => setDetectMessage(e instanceof Error ? e.message : String(e)))
                .finally(() => setDetectBusy(false));
            }}
          >
            Find in Thunderbird
          </button>
          <button
            className="btn"
            type="button"
            disabled={detectBusy}
            onClick={() => {
              if (!isDesktopApp()) {
                setDetectMessage('Detection needs the desktop app.');
                return;
              }
              const host = calDraft.serverUrl.trim() || mailAccounts[0]?.host || '';
              const user = calDraft.username.trim() || mailAccounts[0]?.username || '';
              if (!host) {
                setDetectMessage('Enter the server host below (e.g. mail.host.com), then detect.');
                return;
              }
              setDetectBusy(true);
              setDetectMessage(`Checking ${host}…`);
              detectFromServer(host, user, calDraft.password)
                .then((found) => {
                  setDetected(found);
                  setDetectMessage(`${CALENDAR_SYSTEM_LABELS[found[0].system]} detected on ${host}.`);
                })
                .catch((e: unknown) => setDetectMessage(e instanceof Error ? e.message : String(e)))
                .finally(() => setDetectBusy(false));
            }}
          >
            {detectBusy ? 'Detecting…' : 'Detect from server'}
          </button>
        </div>
        <div className="muted small mb-0">
          Thunderbird is read on this device only (no passwords). Server detection
          tries standard calendar addresses on the host (plus your password, if
          entered, to list calendars).
        </div>
        {detectMessage && <p className="muted small mb-0" role="status">{detectMessage}</p>}
        {detected && detected.length > 0 && (
          <ul className="model-list" aria-label="Detected calendars">
            {detected.map((d) => (
              <li key={d.source + d.url} className="model-row">
                <div className="model-main">
                  <span className="model-name">{d.name} · {CALENDAR_SYSTEM_LABELS[d.system]}</span>
                  <span className="muted small break-all">
                    {d.url}{d.username ? ` · ${d.username}` : ''}{d.detail ? ` · ${d.detail}` : ''}
                  </span>
                </div>
                <div className="model-actions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setCalDraft({
                        ...calDraft,
                        provider: d.provider,
                        serverUrl: d.url,
                        calendarUrl: '',
                        username: d.username || calDraft.username,
                      });
                      setCalMessage(
                        calDraft.password
                          ? 'Filled in. Save, then Test connection.'
                          : 'Filled in. Enter your password, Save, then Test connection.',
                      );
                    }}
                  >
                    Use
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <label className="field-label" htmlFor="cal-provider">Server type</label>
        <select
          id="cal-provider"
          className="input"
          value={calDraft.provider}
          onChange={(e) => setCalDraft({ ...calDraft, provider: e.target.value as CalendarProvider })}
        >
          {(Object.keys(CALENDAR_PROVIDER_LABELS) as CalendarProvider[]).map((p) => (
            <option key={p} value={p}>{CALENDAR_PROVIDER_LABELS[p]}</option>
          ))}
        </select>
        <label className="field-label" htmlFor="cal-server">
          {calDraft.provider === 'ews'
            ? 'Exchange host + path'
            : calDraft.provider === 'graph'
              ? 'Graph host (blank = Microsoft cloud)'
              : 'Server host + path'}
        </label>
        <input
          id="cal-server"
          className="input"
          value={calDraft.serverUrl}
          onChange={(e) => setCalDraft({ ...calDraft, serverUrl: e.target.value })}
          placeholder={
            calDraft.provider === 'ews'
              ? 'mail.company.example/EWS/Exchange.asmx'
              : calDraft.provider === 'graph'
                ? 'graph.microsoft.com/v1.0'
                : 'cal.company.example/dav/calendars/user/me/work/'
          }
          inputMode="url"
        />
        <div className="row-selects">
          <label>
            Protocol
            <select
              className="input"
              aria-label="Calendar protocol"
              value={calDraft.protocol}
              onChange={(e) =>
                setCalDraft({ ...calDraft, protocol: e.target.value as 'http' | 'https' })
              }
            >
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
          </label>
          <label>
            Port (blank = default)
            <input
              className="input"
              aria-label="Calendar port"
              value={calDraft.port}
              onChange={(e) => setCalDraft({ ...calDraft, port: e.target.value })}
              placeholder="8443"
              inputMode="numeric"
            />
          </label>
        </div>
        <div className="muted small mb-0">
          A full URL with its own scheme (https://…) is used as-is; otherwise
          protocol + port above are applied.
        </div>
        {calDraft.provider !== 'graph' && (
          <>
            <label className="field-label" htmlFor="cal-user">Username</label>
            <input
              id="cal-user"
              className="input"
              value={calDraft.username}
              onChange={(e) => setCalDraft({ ...calDraft, username: e.target.value })}
              placeholder="you@company.example"
              autoComplete="username"
            />
            <label className="field-label" htmlFor="cal-pass">Password</label>
            <input
              id="cal-pass"
              className="input"
              type="password"
              value={calDraft.password}
              onChange={(e) => setCalDraft({ ...calDraft, password: e.target.value })}
              placeholder="password or app password"
              autoComplete="off"
            />
          </>
        )}
        {calDraft.provider === 'graph' && (
          <>
            <label className="field-label" htmlFor="cal-token">Access token</label>
            <input
              id="cal-token"
              className="input"
              type="password"
              value={calDraft.token}
              onChange={(e) => setCalDraft({ ...calDraft, token: e.target.value })}
              placeholder="token from your Azure app registration"
              autoComplete="off"
            />
          </>
        )}
        {calDraft.provider === 'caldav' && (
          <>
            <div className="btn-row">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const url = sogoCalendarUrl(calDraft.serverUrl, calDraft.username);
                  if (!url) {
                    setCalMessage('Enter the SOGo host (e.g. mail.host.com) and your username first.');
                    return;
                  }
                  setCalDraft({ ...calDraft, serverUrl: url, calendarUrl: '' });
                  setCalMessage('SOGo address filled in (personal calendar). Save, then Test connection.');
                }}
              >
                Use SOGo address
              </button>
            </div>
            <div className="muted small mb-0">
              SOGo (also what Thunderbird uses): enter the mail host and username,
              then fill in the default calendar path. Another calendar? Copy its
              Location from Thunderbird → calendar Properties.
            </div>
            <label className="field-label" htmlFor="cal-collection">
              Calendar collection URL (optional override)
            </label>
            <input
              id="cal-collection"
              className="input"
              value={calDraft.calendarUrl}
              onChange={(e) => setCalDraft({ ...calDraft, calendarUrl: e.target.value })}
              placeholder="Leave blank to use the server URL above"
              inputMode="url"
            />
          </>
        )}
        {calDraft.provider === 'ews' && (
          <label className="check-row mt-3">
            <input
              type="checkbox"
              checked={calDraft.useNtlm}
              onChange={(e) => setCalDraft({ ...calDraft, useNtlm: e.target.checked })}
            />
            Use NTLM authentication
          </label>
        )}
        {calMessage && <p className="muted small mb-0">{calMessage}</p>}
        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={calBusy}
            onClick={() => {
              const err = validateCalendarConfig(calDraft);
              if (err) {
                setCalMessage(err);
                return;
              }
              setCalBusy(true);
              setCalMessage(null);
              saveCalendarConfig(calDraft)
                .then(() => setCalMessage('Calendar settings saved on this device.'))
                .catch((e: unknown) =>
                  setCalMessage(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setCalBusy(false));
            }}
          >
            {calBusy ? 'Saving…' : 'Save calendar settings'}
          </button>
          <button
            className="btn"
            disabled={calBusy}
            onClick={() => {
              setCalBusy(true);
              setCalMessage(null);
              testCalendarConnection(calDraft)
                .then((r) => setCalMessage(r))
                .catch((e: unknown) =>
                  setCalMessage(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setCalBusy(false));
            }}
          >
            Test connection
          </button>
        </div>
      </section>
      </>
      )}

      {tab === 'ai' && (
      <>
      <section className="card" aria-label="LLM provider">
        <div className="model-title">
          <strong>LLM provider</strong>
        </div>
        <div className="muted">
          Optional summarization of transcripts. Local Ollama stays on this device;
          API keys and Open WebUI send transcript text to that service.
          OpenCode and Claude Code run headless on this machine with your own login;
          Claude Code sends the transcript to Anthropic.
        </div>
        <label className="field-label" htmlFor="llm-preset">Provider</label>
        <select
          id="llm-preset"
          className="input"
          aria-label="LLM provider"
          value={llmDraft.preset}
          onChange={(e) => {
            const preset = e.target.value as LlmPreset;
            const defaults = LLM_PRESETS[preset];
            setLlmDraft({
              ...llmDraft,
              preset,
              baseUrl: defaults.baseUrl || llmDraft.baseUrl,
              model: defaults.model || llmDraft.model,
            });
          }}
        >
          {(Object.keys(LLM_PRESET_LABELS) as LlmPreset[]).map((p) => (
            <option key={p} value={p}>{LLM_PRESET_LABELS[p]}</option>
          ))}
        </select>
        {!isLocalAgentPreset(llmDraft.preset) && (
          <>
            <label className="field-label" htmlFor="llm-base">Base URL</label>
            <input
              id="llm-base"
              className="input"
              value={llmDraft.baseUrl}
              onChange={(e) => setLlmDraft({ ...llmDraft, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              inputMode="url"
            />
            <label className="field-label" htmlFor="llm-path">Completions path</label>
            <input
              id="llm-path"
              className="input"
              value={llmDraft.completionsPath}
              onChange={(e) => setLlmDraft({ ...llmDraft, completionsPath: e.target.value })}
              placeholder="/chat/completions"
            />
            <label className="field-label" htmlFor="llm-key">API key (optional)</label>
            <input
              id="llm-key"
              className="input"
              type="password"
              value={llmDraft.apiKey}
              onChange={(e) => setLlmDraft({ ...llmDraft, apiKey: e.target.value })}
              placeholder="Not needed for local Ollama"
              autoComplete="off"
            />
          </>
        )}
        {llmDraft.preset === 'opencode' && (
          <div className="muted mt-2">
            Uses the OpenCode CLI on this machine — no URL or key needed.
            Pick a model below.
          </div>
        )}
        {llmDraft.preset === 'claude' && (
          <div className="muted mt-2">
            Uses the Claude Code CLI on this machine with your Claude login — no URL or key
            needed. Each summary is saved as a Claude Code session you can continue with{' '}
            <code>claude --resume</code>.
          </div>
        )}
        <label className="field-label" htmlFor="llm-model">Model</label>
        {isLocalAgentPreset(llmDraft.preset) && agentModels !== null && agentModels.length > 0 ? (
          <select
            id="llm-model"
            className="input"
            aria-label="Agent model"
            value={agentModels.includes(llmDraft.model.trim()) ? llmDraft.model : ''}
            onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })}
          >
            {!agentModels.includes(llmDraft.model.trim()) && (
              <option value="">{llmDraft.model.trim() ? `${llmDraft.model} (saved)` : 'Select a model…'}</option>
            )}
            {agentModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <input
            id="llm-model"
            className="input"
            value={llmDraft.model}
            onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })}
            placeholder={isLocalAgentPreset(llmDraft.preset) ? 'Loading models…' : 'llama3.1'}
            disabled={isLocalAgentPreset(llmDraft.preset) && agentModels === null}
          />
        )}
        {isLocalAgentPreset(llmDraft.preset) && agentModels === null && !agentModelsError && (
          <div className="muted small">Loading models…</div>
        )}
        {isLocalAgentPreset(llmDraft.preset) && agentModelsError && (
          <div className="warn small" role="alert">{agentModelsError}</div>
        )}
        {llmMessage && <p className="muted small mb-0">{llmMessage}</p>}
        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={llmBusy}
            onClick={() => {
              setLlmBusy(true);
              setLlmMessage(null);
              saveLlmConfig(llmDraft)
                .then(() => setLlmMessage('LLM settings saved on this device.'))
                .catch((e: unknown) =>
                  setLlmMessage(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setLlmBusy(false));
            }}
          >
            {llmBusy ? 'Saving…' : 'Save LLM settings'}
          </button>
          <button
            className="btn"
            disabled={llmBusy}
            onClick={() => {
              setLlmBusy(true);
              setLlmMessage(null);
              createLlmClient(llmDraft)
                .testConnection()
                .then(() => setLlmMessage('LLM endpoint answered.'))
                .catch((e: unknown) =>
                  setLlmMessage(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setLlmBusy(false));
            }}
          >
            Test connection
          </button>
        </div>
      </section>
      </>
      )}

      {tab === 'app' && (
      <>
      {(!nativeStatus || nativeStatus.backend === 'voxtype') && (
        <section className="card" aria-label="GPU acceleration">
        <div className="model-title">
          <strong>GPU acceleration</strong>
          {gpu?.active && <span className="badge badge-ok">Active</span>}
        </div>
        <div className="muted" aria-label="GPU status">
          {describeGpu(gpu)}
        </div>
        {gpu && gpu.available && !gpu.active && (
          <div
            className="row wrap mt-3"
          >
            <button className="btn btn-primary" disabled={gpuBusy} onClick={() => void enableGpuNow()}>
              {gpuBusy ? 'Enabling…' : 'Enable GPU acceleration'}
            </button>
            <span className="muted small">May ask for your password (polkit / sudo).</span>
          </div>
        )}
        {gpu && gpu.hint && !gpu.active && (
          <p className="muted small mt-2 mb-0">
            Or run: <code>{gpu.hint}</code>
          </p>
        )}
        </section>
      )}
      </>
      )}

      {tab === 'models' && (
      <>
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
        <p className="muted mb-0">
          Native whisper.cpp can auto-detect the language.
        </p>
      </section>

      <h2>Models</h2>
      <p className="muted mt-0">
        Tiered from best (S) to fastest (D). Download the tier you need; only downloaded
        models show up when you transcribe.
      </p>
      {hint && (
        <p className="muted mt-0" aria-label="Accuracy tip">
          {hint}
        </p>
      )}

      {groups.length === 0 && (
        <section className="card">
          <p className="muted mt-0">
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
      )}
    </>
  );
}
