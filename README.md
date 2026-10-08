# Local Transcribe

Privacy-first **desktop** meeting recorder with on-demand transcription. Record first,
transcribe later — everything stays on your device.

Built with Tauri v2 (TypeScript + React frontend, Rust backend). Transcription shells
out to an already-installed native CLI (`whisper-cli` or
[voxtype](https://voxtype.io/)), which unlocks larger, more accurate models
(`large-v3-turbo`, Parakeet) and language auto-detection that a browser cannot run.

Core rule: **recorder first, transcription second.** Recording works with no ASR
model installed. Transcription is manual, post-recording, and never destroys the
audio.

## Features

- **Three recording modes** — Speaker (microphone), Device Audio (everything the computer
  plays — no screen sharing), and Mic + Device (both mixed into one recording, ideal for Zoom/Meet calls).
- **Native recording engine** — the desktop app captures, mixes and encodes audio itself
  (WASAPI loopback on Windows, a CoreAudio tap on macOS 14.2+, PulseAudio/PipeWire on Linux),
  so stopping even an hours-long recording never freezes the window.
- **Import audio files** — turn an existing recording into a meeting for playback and transcription.
- **Crash-safe recording** — audio is written in 5-second Ogg Opus chunks as it is recorded;
  unfinished recordings offer Recover / Delete on next launch.
- **Native transcription** — whisper.cpp via voxtype, with per-track transcription,
  progress stages, cancel/retry, and VAD + preprocessing for accuracy.
- **Tiered model catalog (S–D)** — Settings ranks models by accuracy so you know what to pick.
- **GPU acceleration** — one-click enable (Vulkan/CUDA via voxtype) from Settings.
- **Local files mirror** — finished meetings are copied to
  `<Documents>/Local Transcribe/<title-id>/` (audio, transcript, manifest).
- **GitLab team sharing** — publish transcripts to a project wiki, issue, or repo file;
  your team reads them through normal GitLab membership. No backend of ours.
- **Action items → GitLab issues / calendar events** — after an LLM summary, pick action
  items and turn each into a GitLab issue or a company-calendar event (editable drafts,
  nothing is sent until you approve).
- **Full-text search**, TXT/Markdown/JSON + audio export, per-meeting delete that
  removes every trace (OPFS chunks + IndexedDB).
- **Built for long meetings** — collapsible sections with a jump bar, a transcript that
  follows playback, 1×–2× speed without the chipmunk voice, copy buttons, keyboard keys
  (Space, ←/→, Ctrl+F, Ctrl+N, P), meetings grouped by day with status filters, and an
  optional **Transcribe after recording** setting (off by default).

## Requirements

| What | Why |
| --- | --- |
| Linux (`webkit2gtk-4.1`), Windows 10+, or macOS 12+ | Tauri webview |
| Node 20+ and `npm` | Frontend build |
| Rust toolchain (`cargo`) | Desktop backend build |
| — | Transcription: release builds bundle whisper.cpp; a user-installed `voxtype` / `whisper-cli` (e.g. GPU builds) takes precedence |
| `curl` (or PowerShell on Windows) | Model download for `whisper-cli` backends |
| `ffmpeg` | Dev bench fixtures only |

Install the ASR backend with your distro's voxtype package (e.g. Omarchy's
`voxtype-bin`), or any whisper.cpp build that provides `whisper-cli`
([releases](https://github.com/ggerganov/whisper.cpp/releases)); the app
auto-detects either and lists its models. With a `whisper-cli` backend, model
**Download** buttons fetch `ggml-*.bin` straight from Hugging Face into the
platform model folder (`WHISPER_MODEL_DIR` overrides it).

> `npm install` must be run with `--ignore-scripts` here (a transitive native
> dependency fails to build and is not needed at runtime).

### Platform notes

- **Linux** — full features, including the voxtype GPU-enable button.
- **Windows** — needs the WebView2 runtime (preinstalled on Win 10/11).
  The GPU card is hidden: GPU acceleration comes from the whisper.cpp build
  itself (CUDA/Vulkan), no app step needed.
- **macOS** — Metal acceleration is built into whisper.cpp CPU/Metal binaries.
  Packaging note: the released `.dmg` must add `NSMicrophoneUsageDescription`
  to `Info.plist` (Tauri doesn't inject it), and `getDisplayMedia` is not
  supported in WKWebView — Device / Mic + Device capture may be unavailable,
  use Speaker mode or Import audio file instead.

## Quickstart

```sh
npm install --ignore-scripts

# Desktop app (recommended)
npm run tauri:dev

# Or the UI in a browser (recording works; transcription needs the desktop shell)
npm run dev
```

Production build:

```sh
npm run tauri:build   # installer/bundle
npm run build         # frontend only (dist/)
```

## Usage

1. **New Meeting** — pick Speaker, Device Audio, or Mic + Device (wear headphones
   for calls), or **Import audio file**. Press Start.
2. **Active Meeting** — timer with Pause/Resume/Stop. Nothing is transcribed live unless you turn on **Live transcription** (Settings → Models): then text appears a few seconds after each sentence (the built-in whisper.cpp with a small model such as `base`, fully on-device), and is saved as the meeting's transcript; Re-transcribe redoes it from the whole recording.
3. **Meeting Detail** — play back, then **Transcribe** (pick a downloaded model first
   in Settings). Search the transcript, export it, or delete everything.
4. **Settings** — download/select models (tiered S–D), spoken language, microphone
   access, GPU acceleration, local-files folder, GitLab credentials, and AI assistant.
5. **Meeting Detail** — **Summarize with LLM** (needs Settings → AI assistant) writes
   a summary + key points onto the meeting.

### LLM setup

Settings → **AI assistant**: preset (OpenAI-compatible API, local Ollama, Open WebUI,
**OpenCode (local agent)**, custom), base URL, completions path, optional API key, model. **Test connection**
sends a one-word probe. Note: this is the one feature that sends transcript text
off-device unless you point it at local Ollama.

The **OpenCode** preset needs the desktop app and an installed OpenCode CLI: it runs
headless `opencode run` with your OpenCode login and the `provider/model` id you enter
(see `opencode models`), so no URL or key is required. Meeting Detail → **Summarize
with LLM** / **Re-summarize** then writes the summary + key points onto the meeting
(`Meeting.summary { text, keyPoints, model, createdAt }`).

### GitLab setup

Settings → **GitLab team sharing**: instance URL (default `https://gitlab.com`),
project path (`group/project`) or full project URL for self-hosted instances
(pasting the URL fills in the instance automatically), a personal access token
with `api` scope, and the target (wiki page / issue / repository file). **Test connection** verifies the token
and project. Then each meeting detail page gets **Upload to GitLab** plus an
**Open in GitLab** link. The token lives only in this device's IndexedDB.
Repository uploads go into a folder per meeting (`meetings/<title>-<id>/transcript.md`;
re-uploading updates the file). Once a meeting has a summary, **Upload summary**
writes `summary.md` into the same folder (wiki target: companion page; issue target:
not supported) with an **Open summary in GitLab** link.

## Architecture

```
src/
  app/          React provider (store.tsx) + screens (Dashboard, NewMeeting,
                ActiveMeeting, MeetingDetail, Settings) + styles.css
  asr/          ASREngine interface, native engine (10-min WAV windows over IPC),
                model manager/tiers, VAD, preprocessing, WER scorer
  audio/        MediaRecorder sources (mic/device), permissions, decode/resample
  storage/      OPFS audio chunks + IndexedDB meetings/segments/settings
  domain/       Meeting / TranscriptSegment models
  features/     export, delete-everywhere, disk mirror, audio import
  integrations/ GitLab client + config store
  platform/     desktop bridge (Tauri invoke, no @tauri-apps/api dependency)
src-tauri/      Rust: native_asr (status/models/download/transcribe/cancel),
                storage (save/open local folder), models, GPU enable
bench/          dev-only accuracy harness (WER) — not shipped
e2e/            Playwright specs (deterministic UI states)
```

Key invariants:

- Transcript is derived data; the recording is authoritative.
- Transcription failure never invalidates the recording.
- Single-source modes never mix streams; two-way keeps two separate tracks.
- No accounts, backend, cloud, analytics, or telemetry on audio/transcripts.

## Privacy: what goes online

The app collects no data about you: no accounts, analytics, telemetry or crash
reports, and recording, transcription (including live transcription) and storage
all run on this computer. It goes online **only when you click something**:

| What | When | Where |
| --- | --- | --- |
| Speech model download | You click Download / Set up transcription | Hugging Face (`ggerganov/whisper.cpp`) |
| Update check | You click **Check for updates**, or turn on the launch check (off by default) | GitHub releases |
| GitLab sharing | You click Upload / Test connection / Create GitLab issues (from summary action items) | Your GitLab server |
| Company calendar | You open Calendar, test, detect or approve an event | Your calendar server |
| LLM summary | You click Summarize (Ollama stays local; API/Open WebUI/OpenCode/Claude Code send the transcript to that provider) | The endpoint you configured |

The bundled whisper.cpp engine is built without its network features
(`WHISPER_CURL=OFF`, `GGML_RPC=OFF`, no server). The desktop app records with
its own audio engine (`cpal` for capture, `libopus` for encoding): it talks
only to the operating system's sound service (WASAPI, CoreAudio, or
PulseAudio/PipeWire over its local socket). `src/privacy.test.ts` fails if
code gains a new way to reach the network. The OS web view (WebView2 / WebKit)
follows your operating system's own diagnostic-data settings.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Frontend dev server |
| `npm run tauri:dev` / `tauri:build` | Desktop dev / bundle |
| `npm run build` | Typecheck + frontend build |
| `npx tsc --noEmit` | Typecheck |
| `npx vitest run` | Unit tests (11 files, 85 tests) |
| `npx playwright test` | E2E (6 specs) |
| `npm run bench -- --limit 3` | Transcription accuracy (WER) harness |
| `cd src-tauri && cargo test` | Rust tests (12) |

Verify order: typecheck → unit → e2e. See `bench/README.md` for the harness.

## Docs

- `DESIGN.md` — design tokens, components, spacing rules (single source of truth for UI).
- `AGENTS.md` — contributor/agent notes: stack gotchas, command order, MVP rules.
- `bench/README.md` — accuracy harness usage and fixture docs.

## License

MIT — see [LICENSE](LICENSE).

## Releasing

`.github/workflows/release.yml` builds on real Windows, macOS and Ubuntu runners
and publishes **one GitHub release per platform** for each version:

| Release tag | Binaries |
| --- | --- |
| `v<version>-windows` | `…_windows_x64-setup.exe`, `…_windows_x64.msi`, `…_windows_arm64-setup.exe` |
| `v<version>-macos` | `…_macos_arm64.dmg` (Apple Silicon), `…_macos_x64.dmg` (Intel) |
| `v<version>-ubuntu` | `…_linux_{amd64,arm64}.deb`, `.AppImage`, `.rpm` (Ubuntu 22.04+) |

Every release includes `SHA256SUMS.txt`; files are named
`LocalTranscriber_<version>_<os>_<arch>.<ext>` by `scripts/collect-release.mjs`.

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (the workflow refuses mismatches).
2. Commit, then `git tag v0.1.0 && git push origin v0.1.0`.
3. The three releases are created as **drafts** — review them on GitHub and publish.

### In-app updates

Settings → App → **Updates** checks GitHub on demand (and on launch only if you turn that on)
and, on a click, downloads, verifies, installs and restarts
(`tauri-plugin-updater`, `src-tauri/src/updater.rs`). Windows (NSIS) and macOS
update themselves; on Linux only the AppImage does — `.deb`/`.rpm` installs get a
download link. Installing is disabled while recording or transcribing.

- The app reads `latest.json` from the fixed **`updater`** release. It is rebuilt
  by `.github/workflows/update-manifest.yml` (`scripts/updater-manifest.mjs`)
  whenever a release is published, from the newest *published* version.
- Update artifacts (`-setup.exe`, `.app.tar.gz`, `.AppImage` + `.sig`) are signed
  with the key whose public half is in `tauri.conf.json` → `plugins.updater.pubkey`.
  **Required repo secret:** `TAURI_SIGNING_PRIVATE_KEY` (the private key file's
  contents; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if it has one). Without it
  releases still build, just without in-app update artifacts. Losing the private
  key means installed apps can no longer update — keep a backup.

Run it manually from **Actions → Release** to test (drafts by default). Builds are
not code-signed or notarized yet; the release notes (`.github/release-notes/`)
tell users how to get past SmartScreen / Gatekeeper.
