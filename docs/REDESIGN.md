# Redesign: Local Transcriber × DESIGN.md (Halftone Window)

`DESIGN.md` is the authority. This file maps it onto the app's screens and
records every deliberate deviation. Read both before any UI change.

Source: canvas "Local Transcriber — redesign proposal"
(https://claude.ai/artifact/MLbt9MVbgpNdugGe58nKuh, 23 artboards) with the
"Halftone Window" design system. It replaced the Dell 1996 catalog skin.

## 1. Tokens (`src/app/styles.css :root`)

- Colours, type, spacing, shadow, stroke and size tokens exactly as in
  DESIGN.md (`--pink`, `--hot`, `--berry`, `--ink`, `--paper`, `--panel`,
  `--mute`, `--faint`, `--rule`, …; `--space-*`; `--sh-*`; `--frame-line`).
  `--muted`/`--canvas` remain as aliases for older inline references.
- `--on-hot` = text on the accent; `--sk` scales every offset shadow.
- Fonts are bundled (no network): `@fontsource/archivo-black` (display) and
  `@fontsource/jetbrains-mono` 400/500/700/800 (everything else), imported in
  `main.tsx`. Archivo Black must stay first in `--font-display`: the AppImage's
  fontconfig answers "Arial Black" with a regular bold sans.

## 2. Appearance (runtime theme)

`src/app/theme.ts` (pref `appearance` = `{brand, accent, depth, halftone,
motion}`) writes `--pink`, `--pink-deep`, `--pink-wash` (derived from the
brand), `--hot`, `--on-hot` (black or white, whichever passes) and `--sk` on
`<html>`, and toggles `.noht` / `.still`. Applied in `main.tsx` before first
render; edited in **Settings → Appearance** (`#/settings/appearance`,
`AppearanceSettings.tsx`: presets Halftone / Sunflower / Harbour / Meadow,
brand + accent swatches, colour picker + hex field, contrast readout, shadow
depth, halftone, motion, reset). Covered by `src/app/theme.test.ts` and
`e2e/appearance.spec.ts`.

## 3. Screens (canvas IA)

| Route | Screen | File |
| --- | --- | --- |
| `#/` | **Home**: pink `.record-hero` (title, source radios, mic level, more options, Start / Import), `.waiting` (unfinished wrap-ups, untranscribed), **Coming up** (`.evrec` calendar rows → record with the event's name/agenda), Recent | `screens/Home.tsx` |
| `#/library`, `#/library/month` | **Library**: List (search, `.filters`, `.select-bar` bulk Transcribe/Export/Delete, `.meetings-table`, transcript hits) or Month (`MonthView`) | `screens/Library.tsx`, `screens/MonthView.tsx` |
| `#/active` | **Recording room**: ink `.rec-hero` + `.room-levels`, Pause / Mark moment / Stop; side: agenda progress, moments, live transcript | `screens/RecordingRoom.tsx` |
| `#/wrapup/<id>/<step>` | **Wrap-up** after Stop: `.wrap-steps` (Transcribe → Summary → GitLab → Calendar → Export), `.wrap-card`, `.so-far` | `screens/WrapUp.tsx`, `components/wrap/*` |
| `#/meeting/<id>/<tab>` | **Meeting**: head (Rename / Export ▾ / Share), player with `.player-markers`, `.leftover` banner, `.meeting-tabs` Transcript / Summary / GitLab / Calendar / Export | `screens/MeetingScreen.tsx` |
| `#/settings/<section>` | **Settings**: `.settings-nav` side window with 8 sections (Engine & models, Recording & devices, After recording, Summaries, GitLab & calendar, Storage & privacy, Appearance, App & updates) | `screens/Settings.tsx`, `components/settings/SectionCards.tsx` |
| `#/setup/<n>` | **Setup** (first run, full screen): Welcome, Microphone, Calls, Model, Try it, After recording, Ready | `screens/Setup.tsx` |

Legacy hashes (`#/new`, `#/calendar`, old settings tabs) redirect.

## 4. Component mapping

| Canvas / DESIGN.md | App element |
| --- | --- |
| Nav window | `.topbar`: `.brand`, `.navlink` Home / Library / Settings, `.topbar-fill`, status cells, `.theme-quick` (brand/accent popover), then `.cell.record` **● Record** or `.cell.live` **● REC mm:ss** |
| Page head | `.page-head` pink (Library, Meeting, Wrap-up); `.page-head.is-tool` panel (Settings) |
| Window | `.card`; title bar = first `strong` / `.model-title` / `.card-title` |
| Primary action (hot) | `.btn-hero` (Home Start recording, setup), nav **● Record**, `.btn-stop` |
| Pink feature panel | `.record-hero`, `.cta-red`, `.first-hero` |
| Meeting row / table | `.meeting-item` (Home), `.meetings-table` (Library) |
| Settings rows | `.set-row` (label + hint + control), `.seg-control` radios, `.mode-grid` (summary modes), `.usage-bar` |
| Level meter | `.level-bars` (ink bars, hot = clipping; `.on-ink` in the recording room) |
| Tabs | `.tabs` / `.tab`; `.meeting-tabs` carry a status line and a hot dot when work is left |
| Recording field | `.rec-hero` + `.room-levels`, `.btn-moment` |
| Transcript | `.transcript` with `.sect` (agenda chapters), `.moment-row`, editable `.line-text` |
| Wrap-up tables | `.draft-table` (issues/events), `.route-list` (action-item routing), `.format-grid` |
| Danger window | `.card.danger-zone` |
| Menus / pop-ups | `Popover` portal (`.popover`, `.menu-list`; Export ▾, Theme) — never clipped by a parent |
| Summary editor | `.list-editor` / `.list-row`, `.action-row` (Owner / Task / Due) |
| Participants | `.people` chips, `.gl-picker` (group / filter / project) |
| Install (web / phone build only) | `InstallAppCard` in Settings → App & updates: a normal `.card` with `.set-row`s (install, keep recordings, transcription server) |

## 5. Deviations from the canvas (deliberate)

- **Secrets stay in the settings file** (0600), not the OS keychain — no
  keychain wording in the UI.
- **Speaker detection** is a button on the transcript (sherpa-onnx, bundled in
  release builds), not automatic.
- **Light only**, as in the canvas.

## 6. Verification

`npx tsc --noEmit` → `npx vitest run` → `npm run build && npx playwright test`
→ `npm run tauri:dev` (or the AppImage) for a visual pass on the real shell.
