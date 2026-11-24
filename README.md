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

> **Server edition:** the same app as a self-hosted, multi-user web app in one
> Docker container: accounts, optional single sign-on, private per-user storage.
> See [Server edition (Docker)](#server-edition-docker).

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

## Server edition (Docker)

Run Local Transcribe on your own server so a team can use it from the browser.
It is the desktop app's interface with a backend for accounts and storage, served
by one container.

- **Accounts:** invite-only local accounts, plus optional single sign-on through
  any OpenID Connect provider (Keycloak, Authentik, Entra ID, Google). A group can
  grant admin rights.
- **Private per user:** every user's meetings, recordings and settings live in
  their own folder in the `/data` volume. No one else can open them, admins
  included. Saved tokens (GitLab, calendar, AI) are encrypted on disk.
- **Shared transcription:** one whisper.cpp engine and one set of models
  (downloaded by an admin), shared fairly between users. A CUDA image is available
  for NVIDIA GPUs. Speaker detection is included.
- **Stays on your server:** nothing leaves the host except sign-in with your SSO
  provider and the integrations a user turns on.
- **Recording:** recording runs in the browser, so system sound capture and the
  desktop-only tools (local folders, Thunderbird, OpenCode, Claude Code) are not
  available.

### Try it on one machine

Needs Docker. The app is reachable from this computer only, and the microphone
works on `localhost` without HTTPS.

```sh
umask 077
printf 'LT_ADMIN_EMAIL=you@example.com\nLT_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18)" > lt.env
cat lt.env   # your first admin login
docker run -d --name local-transcribe --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v lt-data:/data --env-file lt.env \
  ghcr.io/grzeskobyte/local-transcribe:latest
```

1. Open <http://localhost:8080> and sign in with the email and password from `lt.env`.
2. **Settings → Models**: download a model (`large-v3-turbo-q5_0` is a good start;
   `base` is fastest on a small CPU).
3. **Settings → Users**: invite people. Each gets a one-time link to set a password.

The admin account is created only when the database has no users, so you can
delete `lt.env` after the first sign-in. To stop: `docker stop local-transcribe`.
To remove everything, including all recordings:
`docker rm -f local-transcribe && docker volume rm lt-data`.

### Run it for a team (Docker Compose)

Clone this repository, check out the `server` branch, and create `.env`:

```sh
git clone -b server https://github.com/GrzeskoByte/local-transcript.git
cd local-transcript
umask 077
cp deploy/.env.example .env   # set LT_ADMIN_EMAIL and LT_ADMIN_PASSWORD
docker compose up -d
```

Browsers allow the microphone only over HTTPS (or on `localhost`), so for other
computers put the app behind HTTPS. The included Caddy proxy gets a certificate
automatically: point a DNS name at the server, open ports 80 and 443, then set in `.env`:

```dotenv
LT_DOMAIN=transcribe.example.com
LT_PUBLIC_URL=https://transcribe.example.com
```

```sh
docker compose --profile https up -d
```

| To | Do |
| --- | --- |
| Turn on single sign-on | Set `LT_OIDC_ISSUER`, `LT_OIDC_CLIENT_ID`, `LT_OIDC_CLIENT_SECRET` (and `LT_OIDC_ADMIN_GROUP`), or use **Settings → Sign-in**. Redirect URI: `<LT_PUBLIC_URL>/auth/oidc/callback`. |
| Use an NVIDIA GPU | `docker compose -f docker-compose.yml -f deploy/docker-compose.gpu.yml up -d` (needs the NVIDIA Container Toolkit). |
| Limit storage per user | `LT_USER_QUOTA_MB=2000` (0 = unlimited). |
| Reach a calendar on your internal network | `LT_CALENDAR_ALLOWED_HOSTS=calendar.company.local,10.0.0.0/8` (private addresses are blocked otherwise). |
| Pin a version | `LT_IMAGE=ghcr.io/grzeskobyte/local-transcribe:0.1.27` (GPU: `0.1.27-cuda`). |
| Upgrade | Back up, then `docker compose pull app && docker compose up -d app`. |
| Reset a password | `docker compose exec app lt-server admin reset-password --email you@example.com` |

Back up by archiving the `lt-data` volume while the app is stopped. It holds
the accounts, recordings, transcripts, models and the encryption key.
[`deploy/README.md`](deploy/README.md) has the full guide: HTTPS with your own
proxy, the settings for each SSO provider, a Keycloak demo, backup and restore,
and account recovery.

**Images** (`ghcr.io/grzeskobyte/local-transcribe`): `latest` and `<version>` are
the CPU image (Linux amd64 and arm64). `cuda` and `<version>-cuda` are the NVIDIA
image (amd64). Release candidates such as `0.1.27-rc.1` get only their version tag.
The server's design and API are in [`docs/SERVER.md`](docs/SERVER.md).

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
| Update check | You click **Check for updates**, or turn on the launch check (off by default); **Include test releases** reads the canary manifest | GitHub releases |
| GitLab sharing | You click Upload / Test connection / Create GitLab issues / Post to wiki / Load my projects & groups / Load members; the issue step also lists project members and refreshes issue states | Your GitLab server |
| Company calendar | You open Calendar, test, detect or approve an event (invitees you typed get the server's invitation e-mail) | Your calendar server |
| Transcription server (Open WebUI) | You turned it on in Settings → Models and click Transcribe / Test connection (or Transcribe after recording is on): the recording's speech goes there as 16 kHz WAV pieces | The server you configured |
| LLM summary | You click Summarize (Ollama stays local; API/Open WebUI/OpenCode/Claude Code send the transcript to that provider) | The endpoint you configured |

In the server edition (`docs/SERVER.md`) the web app talks only to the server
that serves it (`src/platform/server.ts`, `server-bridge.ts`: sign-in, account
and per-user commands); recordings and transcripts stay on that server.

Settings → Storage & privacy → **Network activity** lists every connection the
app made in the last 30 days (where, why, what was sent). Speaker detection
(sherpa-onnx) runs on this computer: the diarizer and its two models are
downloaded at build time with pinned checksums, never by the app.

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
| `npx vitest run` | Unit tests |
| `npx playwright test` | E2E (6 specs) |
| `npm run bench -- --limit 3` | Transcription accuracy (WER) harness |
| `cd src-tauri && cargo test` | Rust tests (12) |

Verify order: typecheck → unit → e2e. See `bench/README.md` for the harness.

## Docs

- `DESIGN.md` — design tokens, components, spacing rules (single source of truth for UI).
- `AGENTS.md` — contributor/agent notes: stack gotchas, command order, MVP rules.
- `bench/README.md` — accuracy harness usage and fixture docs.
- `deploy/README.md` — running the server edition (HTTPS, SSO, GPU, backups).
- `docs/SERVER.md` — server edition design, data layout and API.

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

**Canary builds:** run **Actions → Release** on any branch with *channel = canary*.
It publishes pre-releases tagged `v<next-patch>-canary.<run>-<platform>` at once
(no drafts). The app inside keeps its stable version, so the in-app updater moves
canary users to the next stable release, and `latest.json` ignores canary tags —
stable users are never offered a canary.

Run it manually from **Actions → Release** to test (drafts by default). Builds are
not code-signed or notarized yet; the release notes (`.github/release-notes/`)
tell users how to get past SmartScreen / Gatekeeper.
