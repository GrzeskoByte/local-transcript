# Server edition (Docker) — contract

Branch `server` = `main` + this layer. `main` stays the single-user desktop app.
The server edition is a self-hosted, multi-user transcription tool: accounts
(local + OIDC SSO), per-user isolated data in a host volume, one Docker image.
Everything stays on the host that runs the container; the only outbound calls
are the OIDC provider and the opt-in integrations the user configures.

Keep the layer **additive** (new files) so `main → server` merges stay clean.

## Layout
- `server/` — Rust crate `lt-server` (own `Cargo.toml`, NOT part of `src-tauri`):
  `axum`, `tokio`, `rusqlite` (bundled), `argon2`, `openidconnect`, `chacha20poly1305`,
  plus serde/serde_json/base64/rand/sha2 as needed. Tauri-free files of
  `src-tauri/src` may be reused with `#[path = "../../src-tauri/src/<f>.rs"]`
  (`models.rs`, `proc.rs`); logic from Tauri-coupled files is ported into
  `server/src/` with a `// Ported from src-tauri/src/<f>.rs` note.
  - `server/src/main.rs` (CLI + boot), `config.rs`, `http.rs` (router, static, CSP),
    `auth/` (`local.rs`, `oidc.rs`, `session.rs`, `csrf.rs`), `users.rs`, `admin.rs`,
    `accounts_db.rs` (`/data/app.db`), `ctx.rs` (`UserCtx`), `commands/` (per-user handlers).
- `src/platform/server.ts`, `src/platform/server-bridge.ts`, `src/app/screens/auth/*`,
  `src/app/components/server/*` — frontend server mode.
- `Dockerfile`, `docker-compose.yml`, `deploy/` (Caddyfile, Keycloak example, `.env.example`),
  `.github/workflows/server-image.yml`.

## Config (env)
| var | default | meaning |
|---|---|---|
| `LT_BIND` | `0.0.0.0:8080` | listen address |
| `LT_DATA_DIR` | `/data` | volume root |
| `LT_PUBLIC_URL` | — | external URL (OIDC redirect, cookie `Secure`) — required for OIDC |
| `LT_SECRET_KEY` | — | 32-byte base64; encrypts per-user settings at rest. Generated into `/data/secret.key` (0600) if unset |
| `LT_ADMIN_EMAIL` / `LT_ADMIN_PASSWORD` | — | bootstrap admin on first start when no users exist |
| `LT_LOCAL_LOGIN` | `true` | `false` = SSO only |
| `LT_OIDC_ISSUER`, `LT_OIDC_CLIENT_ID`, `LT_OIDC_CLIENT_SECRET` | — | enables SSO |
| `LT_OIDC_SCOPES` | `openid email profile` | |
| `LT_OIDC_PROVIDER_NAME` | `SSO` | button label |
| `LT_OIDC_ADMIN_GROUP` | — | value in the `groups` claim (`LT_OIDC_GROUPS_CLAIM`, default `groups`) → admin |
| `LT_OIDC_ALLOWED_GROUPS` / `LT_OIDC_ALLOWED_DOMAINS` | — | comma lists; empty = any |
| `LT_SESSION_TTL_HOURS` / `LT_SESSION_IDLE_HOURS` | `168` / `24` | |
| `LT_USER_QUOTA_MB` | `0` | 0 = unlimited; recording writes beyond it fail |
| `WHISPER_CLI_PATH` | `/opt/lt/bin/whisper-cli` | ASR CLI |
| `LT_DIARIZE_DIR` | `/opt/lt/diarize` | sherpa-onnx diarizer |

Env values win over values set in the admin UI (UI shows them as locked).

## Data layout
```
/data/app.db                       users, sessions, invites, audit, server settings
/data/secret.key                   (if LT_SECRET_KEY unset)
/data/models/                      shared ASR models (admin downloads)
/data/users/<uid>/meetings.db      meetings, segments, kv (calendar cache)
/data/users/<uid>/settings.enc     per-user settings (ChaCha20-Poly1305, LT_SECRET_KEY)
/data/users/<uid>/recordings/meetings/<id>/[<track>/]<chunk>   same layout as src-tauri recordings.rs
/data/users/<uid>/files/           mirrored meeting folders (optional)
```
`<uid>` = random 128-bit hex, never user-controlled. Every handler resolves paths from
`UserCtx.user_dir` only — never from a client-supplied user id. Path segments keep the
`valid_segment` / `safe_relative` guards.

## Accounts DB (`app.db`, schema versioned via `PRAGMA user_version`, migrations on boot after a copy to `app.db.bak-<ver>`)
- `users(id TEXT PK, email TEXT UNIQUE COLLATE NOCASE, name, role TEXT CHECK(role IN('admin','member')), auth TEXT ('local'|'oidc'), oidc_issuer, oidc_sub, password_hash, disabled INT, created_at, last_login_at)`; UNIQUE(oidc_issuer, oidc_sub).
- `sessions(token_hash TEXT PK (sha256 hex), user_id, csrf TEXT, created_at, last_seen_at, expires_at, user_agent)`.
- `invites(token_hash PK, email, role, created_by, expires_at, used_at)`.
- `audit(id INTEGER PK, at, user_id, actor_id, action, detail)` — logins, failed logins, admin actions. Never meeting content.
- `server_settings(key PK, value JSON)` — OIDC config set in the UI, local-login switch, default model.

Rules: argon2id; login rate limit (5 fails / 15 min per email+IP → 429); SSO users matched by
`(issuer, sub)` only, created on first login (role from admin group; first user ever = admin),
email/name refreshed each login; disabled users cannot log in and their sessions are dropped.
The last active admin cannot be demoted/disabled/deleted. **Admins never get access to another
user's meetings, recordings or settings** — there is no endpoint for it.
Deleting a user deletes `/data/users/<uid>/` entirely + sessions; audit keeps the action.

## HTTP API
Cookie `lt_session` (HttpOnly, SameSite=Lax, `Secure` when `LT_PUBLIC_URL` is https, Path=/).
Every state-changing request (`POST/PUT/DELETE` under `/api`) needs header `X-LT-CSRF: <csrf>`
(value from `/api/me`); missing/wrong → 403. JSON errors: `{ "error": "<message>" }`.

Public:
- `GET /api/health` → `{ ok: true, version }`
- `GET /api/auth/config` → `{ localLogin: bool, sso: null | { name } , inviteOnly: true }`
- `POST /api/auth/login` `{ email, password }` → 200 `{ user }` + cookie | 401 | 429 (no CSRF needed; checks `Origin` against `LT_PUBLIC_URL` when set)
- `POST /api/auth/invite/accept` `{ token, name, password }` → `{ user }` + cookie
- `GET /auth/oidc/start` → 302 to provider (state, nonce, PKCE in a short-lived signed cookie)
- `GET /auth/oidc/callback` → validates, upserts user, sets session, 302 to `/`
Authenticated:
- `GET /api/me` → `{ user: {id,email,name,role,auth}, csrf, capabilities: string[] }`
- `POST /api/auth/logout` → clears session; `{ redirect?: <provider end_session_url> }`
- `POST /api/me/password` `{ current, next }` (local accounts)
- `GET /api/me/sessions`, `DELETE /api/me/sessions/:id` (id = first 12 hex of token_hash)
- `GET /api/me/export` → zip of the user's whole folder (meetings.db as JSON + recordings + settings decrypted)
- `DELETE /api/me` `{ confirm: "<email>" }` → deletes own account + data (not the last admin)
- `GET /api/me/usage` → `{ bytes, quotaBytes }`
- `POST /api/invoke/:cmd` → per-user command (below)
Admin (`role=admin`, 403 otherwise):
- `GET /api/admin/users` → `[{ id,email,name,role,auth,disabled,createdAt,lastLoginAt,bytes }]`
- `PATCH /api/admin/users/:id` `{ role?, disabled?, name? }`, `DELETE /api/admin/users/:id`
- `POST /api/admin/invites` `{ email, role }` → `{ url, expiresAt }` (7 days); `GET/DELETE /api/admin/invites[/:id]`
- `GET/PUT /api/admin/settings` → `{ localLogin, oidc: {issuer,clientId,clientSecretSet,scopes,providerName,adminGroup,allowedGroups,allowedDomains}, locked: string[] }`
- `POST /api/admin/oidc/test` → fetches discovery, `{ ok, issuer, error? }`
- `GET /api/admin/audit?limit=200`
- Model downloads (`native_asr_download_model`, `native_asr_enable_gpu`) are admin-only commands.

## `POST /api/invoke/:cmd`
Same names, args and results as the Tauri commands in `src-tauri/src` (args JSON body,
camelCase like Tauri). Raw-body commands (Tauri `invokeDesktopRaw`) take the bytes as
`application/octet-stream` with the same `x-*` headers. Binary results come back as
`application/octet-stream`, everything else as JSON (a command returning `()` → `null`).
Errors → 400 `{ error }` (the Tauri `Err(String)`). Unknown/unsupported → 404 `{ error }`.

Supported (and listed in `/api/me` `capabilities`):
- Settings (per user, encrypted at rest): `native_settings_load`, `native_settings_set`
- Recordings store (per user, quota-checked): `native_recording_write|write_meta|read_meta|list|read|delete`
- ASR (shared CLI + models, per-user job, fair queue: one transcription child at a time,
  round-robin across users; `native_asr_cancel` cancels only the caller's job):
  `native_asr_status`, `native_asr_models`, `native_asr_transcribe`, `native_asr_cancel`,
  `native_asr_download_model` (admin), `native_asr_download_progress`
- Live: `native_live_transcribe`, `native_live_cancel` (own slot per user, max 2 concurrent server-wide → busy error)
- Diarization: `native_diarize_status|run|progress|cancel` (per user)
- Calendar (server-side curl, user's own config): `native_calendar_test|create|fetch|probe`
- Server-only meeting DB (replaces IndexedDB in server mode; JSON values are the frontend's objects):
  - `server_db_get {store,key}` → value | null
  - `server_db_get_all {store}` → value[]
  - `server_db_get_by_index {store:"segments", index:"by-meeting", key}` → value[]
  - `server_db_put {store,value}`; `server_db_delete {store,key}`
  - `server_db_put_if_exists {store,value}` → bool (single transaction)
  - `server_db_patch {store,key,patch}` → merged value | null — shallow merge in one transaction
    (frontend `updateMeeting(id, partial)`)
  - `server_db_put_if_unchanged {store,value,expected}` → bool — write only when the stored value
    still equals `expected` (frontend function-form `updateMeeting`: read, apply, retry ≤ 5×)
  - `server_db_commit_transcript {meetingId, segments, patch}` → bool — atomically: if meeting
    exists, delete its segments, insert `segments`, put `{...meeting,...patch,transcriptionStatus:"completed"}`
  - `server_db_set_segment_speakers {meetingId, speakers: {segmentId: speaker}}`
  - `server_db_delete_meeting {id}` — meeting + its segments in one transaction
  - stores: `meetings` (key `id`), `segments` (key `id`, index `meetingId`), `kv` (key `key`)
- Not supported (desktop only): native recorder, system audio, audio diag, level monitor,
  updater, relaunch, folder picker, keep-awake, privacy settings, open/reveal folder, export to
  Downloads, Thunderbird detection, opencode, Claude Code, webview DB reset, storage dir moves.

## Frontend server mode
- `src/platform/server.ts`: `isServerApp()` (true when `index.html` carries
  `<meta name="lt-edition" content="server">`, injected by `lt-server` when serving `/`),
  `loadServerSession()` (`/api/me`), `serverInvoke(cmd,args)` / `serverInvokeRaw(cmd,bytes,headers)`
  (fetch with cookie + CSRF; 401 → sign-in screen), `hasCapability(cmd)`.
- `invokeDesktop` / `invokeDesktopRaw` route to the server when `isServerApp()`.
  `isDesktopApp()` stays **false** in server mode; add `hasNativeBackend()` (= desktop || server)
  and switch gates for ASR, settings file, recordings store, calendar, diarization to it;
  desktop-only features stay behind `isDesktopApp()`.
- Storage: in server mode `database.ts` (`db.*`), `meetings.ts`, `transcripts.ts` use the
  `server_db_*` commands; `recordings.ts` always uses the server recordings store.
- Recording: browser `MediaRecorder` (the existing non-native path); chunks go to
  `native_recording_write` as they are produced.
- Export: normal browser download. Model downloads/GPU UI only for admins.
- New screens (follow `DESIGN.md`, record in `docs/REDESIGN.md`): **Sign in** (`#/signin`;
  local form and/or "Sign in with <name>"), **Accept invite** (`#/invite/<token>`),
  Settings → **Account** (profile, password, sessions, usage, export my data, delete account),
  Settings → **Users** (admin: list, invite, role, disable, delete, usage), Settings →
  **Sign-in** (admin: local login switch, OIDC config + Test, locked fields), Settings →
  **Audit log** (admin). Nav shows the signed-in user + Sign out.
- Privacy copy in server mode: "Your recordings and transcripts stay on this server; only you can open them."
- Accounts never mix in the browser: `serverInvoke*` refuses to send without a session and drops an
  answer that arrives after the account changed (`sessionEpoch`/`sessionGuard`, `SessionChangedError`);
  recorder chunks and imports are bound to the session that started them; sign-out with a recording
  asks, then stops + saves, cancels imports/transcriptions and logs out; sign-in, sign-out, 401 and
  account deletion do a full page reload; browser prefs are keyed `u:<userId>:<key>` and nothing
  unscoped is read or migrated (`platform/prefs.ts`). `oidc.scopes` is a string array on the wire.
