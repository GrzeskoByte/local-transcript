# AGENTS.md — local-transcribe

Spec source of truth: `/home/gsierock/obsidian_vaults/gs_n/local-transcribe/MVP.md`. The app is **Tauri-only** — there is no PWA and no in-browser ASR engine. Scaffolded: Vite React-TS + Tauri v2 (see README.md).

## Response style
- **Be concise. Every response.** Short sentences, bullet points, no filler, no restating the request, no play-by-play of tool calls. State what changed and the command/result that verified it. Skip optional commentary unless asked.

## Intended stack
- TypeScript + React + Vite, packaged with Tauri v2 (`src-tauri/`). Test: Vitest + Playwright.
- Audio: `MediaRecorder` primary (§8); Web Audio API / AudioWorklet allowed per recommended stack (§6) for decode/resample only.
- Storage: OPFS for audio chunks/blobs, IndexedDB for meetings/segments/settings/model metadata. Never store large audio in IndexedDB. OPFS/IndexedDB are the source of truth; the desktop shell also mirrors finished meetings to a local folder.
- Transcription: **the native desktop CLI is the only ASR path** (whisper.cpp / voxtype) behind the `ASREngine` interface. Decode/resample to chunks before ASR (§12). No network calls for audio/transcripts.
- **Quality lever = model size, not engine.** `nativeAccuracyHint()` (model-manager) nudges toward `large-v3-turbo` (Whisper) or `parakeet-tdt-0.6b-v3`; `describeNativeRuntime()` shows the desktop backend + acceleration in the UI. Native model names are the CLI's (`large-v3-turbo` default/recommended, Parakeet best) and native language options include an honest `auto` (whisper.cpp can detect).
- **ASR is not covered by Playwright here:** no display/GPU/native CLI in CI. Playwright only tests the deterministic UI (loader/error/settings states); validate DSP/decoding changes with the dev bench (`bench/`) or a Node probe.

## Desktop (Tauri) native path
- Tauri v2 shell in `src-tauri/`. It shells out to an **already-installed** CLI; `cmake` is absent in this sandbox, so never build whisper.cpp from source.
- Rust commands (structs camelCase): `native_asr_status`, `native_asr_models`, `native_asr_download_model`, `native_asr_enable_gpu`, `native_asr_transcribe`, `native_asr_cancel`. Backend discovery: `$WHISPER_CLI_PATH` → `whisper-cli|whisper-cpp|main` → `voxtype`.
- **GPU acceleration is root-only:** `native_asr_enable_gpu` runs `voxtype setup gpu --enable` via `pkexec` then `sudo -n` (returns the manual `sudo …` hint on failure). `NativeAsrStatus.gpu` (`GpuInfo`: `available/active/backend/devices/hint`) comes from `voxtype setup gpu --status`; Settings shows it and offers an Enable button only when `gpu.available && !gpu.active`. Enabling GPU switches the voxtype variant (e.g. Vulkan Whisper); Parakeet additionally needs the ONNX+CUDA/MIGraphX variant (`sudo voxtype setup onnx --enable`).
- **Desktop capture needs the Rust permission handler:** `src-tauri/src/lib.rs` registers `.on_permission_request` allowing `Microphone`/`Camera`/`DisplayCapture`. On Linux WebKitGTK denies any media request the embedder does not handle, and `PermissionResponse::Default` resolves to Deny — that is why `getUserMedia`/`getDisplayMedia` fail with a cryptic `NotAllowedError` in the desktop shell. Tauri 2.12 exposes the handler at app, `WebviewBuilder` and `WebviewWindowBuilder` level (the webview-level handler wins; app-level is the fallback). No extra cargo dependency is needed.
- Frontend bridge is `src/platform/desktop.ts` (`invokeDesktop` reads `window.__TAURI_INTERNALS__`) — **no `@tauri-apps/api` dependency**. `isDesktopApp()` gates storage-mirroring and backend probes.
- **Local files (desktop):** finished meetings are mirrored to `<Documents>/Local Transcribe/<title-id>/` (audio tracks + `transcript.txt|md|json` + `meeting.json`) by the pure-Rust commands `native_storage_dir` / `native_save_file` / `native_open_storage_dir` (`src-tauri/src/storage.rs`; `safe_relative` rejects absolute/`..` paths). Frontend: `src/platform/desktop-storage.ts` + `src/features/meetings/disk-sync.ts` (`mirrorMeetingToDisk`), called best-effort from `store.tsx` after stop and after transcription. Controlled by the `desktop-save-to-disk` localStorage pref and the Settings **Local files** card. OPFS/IndexedDB remain the source of truth.
- `NativeASREngine` (`src/asr/native-engine.ts`) ships 16 kHz mono WAV as base64 in 10-minute windows; `NativeASREngine.initialize` throws `installHint` when no CLI is found. `TranscriptionService` defaults to it.
- Model + language storage are native-only: `getModelMeta()` / `setModelMeta()` (key `asr-model-meta-desktop`) and `getTranscriptionLanguage()` / `setTranscriptionLanguage()` (key `asr-language-desktop`).
- Native ASR is not exercised by Playwright (no display/GPU in CI); unit-test the pure helpers and keep the browser suite green.

## Dev bench (not shipped)
- `bench/` is a **dev-only** accuracy harness (WER) that runs the real `preprocessForASR` + `compactSpeech` and the chunking/decoding config from `src/asr/pipeline-config.ts` against Whisper fixtures in Node `cpu`/q8, using `@huggingface/transformers` (a **devDependency**). It is not part of the app bundle.
- `resolveAsrRuntime()` in `src/asr/pipeline-config.ts` is kept solely for this harness (`ASR_CHUNK_LENGTH_S`/`ASR_STRIDE_LENGTH_S`/`ASR_NO_REPEAT_NGRAM_SIZE` likewise). Do not wire it back into the app.
- `npm run bench` — `--model Xenova/whisper-small.en` for accuracy numbers, `--max-wer 0.2` for CI gating. See `bench/README.md`.

## Core rules (from MVP — do not violate)
- Recording and transcription are separate. Recording must fully work with no ASR model installed. `transcriptionStatus: "not_started"` is valid. Never auto-transcribe after stop. Transcript is derived data; recording is authoritative (§11).
- Transcription failure must never destroy/invalidate the recording. Failure UI: "Your original recording is still safe." + Retry (§13).
- Speaker (`getUserMedia({audio:true})`), Device (`getDisplayMedia({video:true,audio:true})`), and **Two-way** (`dual`: both at once) modes. Single-source modes never mix streams. Label as "Device Audio", never promise system-audio capture (§2). Device mode: if no audio track, show full MVP §18 message — do not request mic permission for device mode; request mic only for mic/dual starts. `dual` is an intentional extension beyond MVP §2 (user-requested, for Zoom calls): mic + device are recorded as **two separate OPFS tracks**, so speaker = track (`trackSpeakerLabel` → 'Me'/'Others') with no diarization. Warn users to wear headphones so the mic doesn't re-capture playback.
- **Media capture failures are turned into guidance, never raw DOMExceptions.** `src/audio/permissions.ts` (`mediaAccessError` → `MediaAccessError.failure {message, hint, retryable, code}`) classifies `NotAllowedError`/`NotFoundError`/`NotReadableError`; `microphone.ts`/`device-audio.ts` rethrow it, NewMeeting shows hint + **Try again**, and Settings has a **Grant microphone access** card (`queryMicrophonePermission()` + `primeMicrophonePermission()`, which actually triggers the permission prompt). Guidance is desktop-first (OS privacy settings, no address bar); an insecure context (`!isSecureMediaContext()`) can never prompt.
- Recording state: `IDLE → STARTING → RECORDING ↔ PAUSED → STOPPING → COMPLETED`; any active state → `ERROR` → Recover/Save/Retry (§9). Must support start/pause/resume/stop + long recordings, and survive in-app navigation (§4).
- Persist recorder chunks incrementally (`meetings/{id}/00000N.webm`; two-way: `meetings/{id}/{microphone|device}/00000N.webm`) so crash recovery works. On launch, detect unfinished recording → offer Recover / Delete (§15). `recordings.ts` is track-aware: `listTracks()` + `listChunkNames(id, track)` / `readRecordingBlob(id, mime, track)`; track `''` = legacy flat single-track. Select container/codec via runtime capability check (§8).
- Storage: check `navigator.storage?.estimate()` before recording, warn when low; storage failure during recording must surface explicitly — never report unsaved audio as saved (§19).
- Delete meeting = remove IndexedDB metadata + segments AND all OPFS chunks. No orphans (§23).
- ASR model: native only. `NATIVE_DEFAULT_MODEL` / `NATIVE_RECOMMENDED_MODEL` and `NATIVE_LANGUAGE_OPTIONS` in `model-manager.ts`. Lifecycle `Not Installed → Downloading → Verifying → Installed → Loaded → Ready`; show download progress (§16). The **Settings screen (`#/settings`) owns browsing/downloading/selecting**; models are tiered S–D by `accuracy` in `src/asr/model-tiers.ts` (`nativeCatalog`/`groupByTier`), and Meeting Detail offers **only installed models**.
- Privacy: no accounts, backend, cloud, analytics/telemetry on audio/transcripts. UI line: "Your recording and transcript stay on this device." Do not claim absolute security (§17).

## Planned layout
- `src/audio/` (microphone.ts, device-audio.ts, recorder.ts, formats.ts), `src/asr/` (engine.ts, native-engine.ts, model-manager.ts, model-tiers.ts, transcription-service.ts; `pipeline-config.ts` is bench-only), `src/storage/` (database.ts, meetings.ts, transcripts.ts, recordings.ts), `src/domain/`, `src/features/` (meetings, recording, transcription, search, settings), `src/platform/` (desktop bridge), `src-tauri/`.
- Key interfaces: `AudioSource`, `AudioRecorder`, `ASREngine`, `TranscriptionService`, `Meeting`, `TranscriptSegment` — as defined in MVP §§10–12, 25. Keep ASR behind the interface.

## Screens only (MVP §20)
Dashboard, New Meeting, Active Meeting (timer + Pause/Stop, no transcript), Meeting Detail (play, Transcribe/Cancel/Retry/Re-transcribe with progress %, transcript viewer, export, delete), Settings (engine status, spoken language, tiered model catalog — download/use). No live/auto transcription, diarization/identification, summaries/action items, LLM/embeddings/semantic search, cloud, accounts, calendar/Zoom-Meet-Teams APIs, payments, OS audio hacks (§5).
- Search = plain full-text over stored segments only; untranscribed meetings not searchable by content (§21).
- Export = TXT + Markdown + JSON (preserve startMs/endMs/metadata per §22 example; includes `speaker` when present) + original audio file (two-way recordings export one file per track — separate WebM streams cannot be concatenated into one playable file).
- **GitLab team sharing (no backend of our own):** `src/integrations/gitlab.ts` (`GitlabClient` — PAT auth, `testConnection`, `uploadMeeting` to wiki/issue/repo-file) + `gitlab-store.ts` (config in IndexedDB key `gitlab-config`, token never leaves the device). Settings **GitLab team sharing** card owns URL/project/token/target; Meeting Detail has **Upload to GitLab** (needs a completed transcript) + `Open in GitLab` link, persisted on `Meeting.gitlab {url, target, uploadedAt}`. Team access = GitLab project membership.

## Commands
- `npm install --ignore-scripts`
- `npm run dev` / `npm run build` / `npm run preview`
- `npx tsc --noEmit`, `npx vitest run`, `npx playwright test`
- `npm run bench` — dev-only ASR accuracy harness (WER) in `bench/`; see above and `bench/README.md`.
- `cd src-tauri && cargo check` — desktop backend (needs `webkit2gtk-4.1`). `npm run tauri:dev` / `tauri:build` require the Tauri CLI.
- Verify order: typecheck → unit → e2e. E2E must cover: record → stop → close/reopen → play → transcribe → reopen → transcript persists; delete removes all data.
