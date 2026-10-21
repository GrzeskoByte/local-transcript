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

## 3. Component mapping

| Canvas / DESIGN.md | App element |
| --- | --- |
| Nav window | `.topbar` (`nav[aria-label=Main]`): `.brand` (dots + `local-transcriber`), `.navlink` Meetings / Calendar / Settings (`.active` = ink + hot underline), `.topbar-fill`, `.cell` status cells (`.busy-chip` "Transcribing N% · title", `.update-chip`, `.model-chip` with `[x]`/`[ ]`/`[~]`), then `.cell.record` **● Record Ctrl N** or `.cell.live` **● REC mm:ss** (paused = pink) |
| Page head | `.page-head` pink (Dashboard, New Meeting, Meeting Detail); `.page-head.is-tool` panel (Settings, Calendar); halftone = `::before` |
| Window | `.card`; title bar = first `strong` / `.model-title` / `.card-title` (ink, `::before` dots) |
| Window foot bar | `.start-bar` (New Meeting: panel strip with Start / Import / Cancel) |
| Primary action (hot) | nav **● Record**, Active Meeting **Stop & save**; everything else is ink/paper |
| Pink feature panel | `.cta-red` (Dashboard "Set up transcription") — pink field + halftone + `sh-lg` |
| Meeting row | `.meeting-item` (title / meta / tags / ink chevron), `.row-menu` ⋯ square |
| Tags | `.pill` with mode glyphs and `[x]`/`[ ]`/`[!]` status marks; `.badge-*` share them |
| Tabs | `.tabs` / `.tab` (Settings sections, Dashboard filters) |
| Tier module | `.tier-card` (`details`/`section`), `.tier-badge` (S = hot), `.model-row.active` |
| Recording field | `.rec-hero` (ink, `sh-xl`, hot halftone, round lamp, 124 px timer) |
| Transcript | `.transcript` (berry timestamps, `li.active` pink-wash + hot bar, pink `mark`) |
| Jump bar | `.section-nav` (sticky under the nav window) |
| Toasts | `.notice-toast` (ink bar), `.error-toast` (hot bar) |
| Danger window | `.card.danger-zone` (hot title bar) |
| Calendar month | `.cal-grid`: ink weekday heads, ruled cells, today = hot number, selected = pink, dots ink (recorded) / hot (server) |
| Footer | `.footer-band` (black band, pink `[x]`) |

## 4. Deviations from the canvas (deliberate)

- **IA kept.** Nav reads **Meetings / Calendar / Settings** (the canvas has
  Home / Library / Settings with Calendar as a Library "Month" tab); routes,
  screen order and every accessible name the e2e suite relies on are
  unchanged. New Meeting stays its own screen (the canvas folds it into Home).
- **Settings sections stay tabs** (`#/settings/<tab>`), not a side window;
  Appearance is a new tab.
- **Not built yet** (canvas proposals that need new features, not a skin):
  Home "Waiting for you" / "Coming up" panels, Library filters + bulk actions,
  the 8-step first-run wizard, Moments (press M), per-speaker transcript
  filter and agenda chapters on the waveform, the guided after-Stop wrap-up
  and its tabbed revisit, the storage meter, Settings "after recording" /
  "summaries" split.
- **Light only**, as in the canvas.

## 5. Verification

`npx tsc --noEmit` → `npx vitest run` → `npm run build && npx playwright test`
→ `npm run tauri:dev` (or the AppImage) for a visual pass on the real shell.
