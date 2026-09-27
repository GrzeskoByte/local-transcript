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

- **Three recording modes** — Speaker (microphone), Device Audio (shared tab/window),
  and Mic + Device two-way (separate tracks labelled *Me* / *Others*, ideal for Zoom/Meet calls).
- **Import audio files** — turn an existing recording into a meeting for playback and transcription.
- **Crash-safe recording** — `MediaRecorder` writes 5-second chunks straight to OPFS;
  unfinished recordings offer Recover / Delete on next launch.
- **Native transcription** — whisper.cpp via voxtype, with per-track transcription,
  progress stages, cancel/retry, and VAD + preprocessing for accuracy.
- **Tiered model catalog (S–D)** — Settings ranks models by accuracy so you know what to pick.
- **GPU acceleration** — one-click enable (Vulkan/CUDA via voxtype) from Settings.
- **Local files mirror** — finished meetings are copied to
  `<Documents>/Local Transcribe/<title-id>/` (audio, transcript, manifest).
- **GitLab team sharing** — publish transcripts to a project wiki, issue, or repo file;
  your team reads them through normal GitLab membership. No backend of ours.
- **Full-text search**, TXT/Markdown/JSON + audio export, per-meeting delete that
  removes every trace (OPFS chunks + IndexedDB).

## Requirements

| What | Why |
| --- | --- |
| Linux with `webkit2gtk-4.1` | Tauri webview |
| Node 20+ and `npm` | Frontend build |
| Rust toolchain (`cargo`) | Desktop backend build |
| `voxtype` **or** `whisper-cli` on `PATH` | Transcription (recording works without it) |
| `ffmpeg` | Dev bench fixtures only |

Install the ASR backend with your distro's voxtype package (e.g. Omarchy's
`voxtype-bin`); the app auto-detects it and lists its models.

> `npm install` must be run with `--ignore-scripts` here (a transitive native
> dependency fails to build and is not needed at runtime).

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
2. **Active Meeting** — timer with Pause/Resume/Stop. Nothing is transcribed live.
3. **Meeting Detail** — play back, then **Transcribe** (pick a downloaded model first
   in Settings). Search the transcript, export it, or delete everything.
4. **Settings** — download/select models (tiered S–D), spoken language, microphone
   access, GPU acceleration, local-files folder, and GitLab credentials.

### GitLab setup

Settings → **GitLab team sharing**: instance URL (default `https://gitlab.com`),
project path (`group/project`), a personal access token with `api` scope, and the
target (wiki page / issue / repository file). **Test connection** verifies the token
and project. Then each meeting detail page gets **Upload to GitLab** plus an
**Open in GitLab** link. The token lives only in this device's IndexedDB.

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
