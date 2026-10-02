# Redesign plan: Local Transcriber × DESIGN.md (Dell 1996)

`DESIGN.md` is the authority. This file maps its brand language onto a desktop
meeting recorder and records every deliberate deviation. Read both before any
UI change.

**Design read:** desktop productivity app (record, transcribe, review) for
people running their own meetings, re-skinned in the 1996 catalog language:
literal black frame, flat tinted ribbon cards, Arial Black eyebrows, Times body,
square everything, hard 1 px edges, yellow stickers.

**Dials:** variance 4 (app IA stays put), motion 2 (feedback only: press,
blinking REC), density 6 (catalog density, as DESIGN.md asks).

## 1. Audit of the old UI (retired)

| Area | Before | Problem against DESIGN.md |
| --- | --- | --- |
| Palette | slate neutrals + indigo `#4f46e5` brand, purple gradient logo | accent outside the closed palette; gradients banned |
| Type | system-ui sans everywhere | no display weight, no serif body |
| Shape | 10–20 px radii, pills | DESIGN.md: 0 px everywhere, round only for seals |
| Depth | soft drop shadows on every card | soft shadows banned; hairline + frame only |
| Shell | dark navy sidebar | no frame; dark rail reads as a different brand |
| Pills | pastel rounded chips | should be square stickers / tint blocks |
| Inline styles | 83 `style={{}}` one-offs | tokens/utilities only |

Kept: information architecture, routes, labels, every accessible name the e2e
suite relies on (`.sidebar .model-chip`, `h1 + p.muted`, `.transcript li`,
`.cal-grid`, `.cal-dot.server`, button texts).

## 2. Tokens (`src/app/styles.css :root`)

- Colours: exactly the DESIGN.md palette (`--primary #e91d2a`, `--ink #000`,
  `--canvas #fff`, `--yellow #fcc20f`, `--purple #6a26a4`, `--link #0000ee`,
  8 tints). Aliases `--frame`, `--muted` (`#333`, AA on white and on every tint).
- Fonts: `--font-display` Arial Black → Archivo Black (bundled via
  `@fontsource/archivo-black`, because Linux has no Arial Black) ;
  `--font-ui` Helvetica → Arial → Liberation/Nimbus Sans; `--font-body` Times
  New Roman → Liberation Serif/Nimbus Roman.
- Type scale = DESIGN.md typography tokens (36/24/16/14/14/12/11/12/12).
- Spacing = DESIGN.md spacing tokens (`--sp-xxs` … `--sp-section-lg`).
- Radius: `0`; `--round` only for the seal.
- Form rhythm (one rule for every form): label → control `--field-gap` 10 px,
  control → hint `--hint-gap` 6 px, field group → next label `--group-gap` 20 px,
  last control → action row 16 px. Side-by-side fields use `.row-selects`
  (label stacked over its control with the same gaps).
- Depth: `--hair: 1px solid #000`, `--frame-w: 8px`, `--bevel: 2px 2px 0 #000`
  (stickers only).

## 3. Component mapping

| DESIGN.md component | App element |
| --- | --- |
| `page-frame` | `.layout`: 8 px black frame around the whole window (4 px ≤ 820 px) |
| `top-banner` | new black `.topbar`: wordmark, tagline, phone-callout, sticker |
| `phone-callout` | red-on-black status in the banner: `ON-DEVICE` idle, `● REC 12:34` while recording (links to Active Meeting) |
| `buy-a-dell-sticker` | yellow **New recording** sticker in the banner (replaces the nav item) |
| `icon-label-nav` | white left rail (`.sidebar`): icon + uppercase Helvetica labels, active row = black fill + red indicator |
| `cert-seal` | round red "100% local" seal at the bottom of the rail |
| `section-eyebrow-*` | every screen's `.page-head`: tinted block, Arial Black caps title |
| `ribbon-card-title` + `ribbon-card-body-*` | `.card`: white title bar with black underline (`.card-title` / first `<strong>`), white or tinted body |
| `cta-block-red` | at most one per screen: **Stop & save** (Active Meeting), **Set up transcription** panel (Dashboard first run) |
| `new-burst-sticker` | rotated yellow **NEW!**-style sticker: update available, "Recommended" model, selected source |
| `button-primary/secondary` | `.btn-primary` black, `.btn` white outline; uppercase Helvetica 12 bold |
| `button-text-link` | `.link-btn`, `.backlink`: underlined `#0000ee` Times |
| `text-input` | `.input`, selects, textareas: 1 px black, Times 14 |
| `footer-band` | `.footer-band` under every screen: privacy line + engine status, body-sm |
| `ex-data-table-cell` | transcript rows, model rows, calendar grid: 1 px black rules |

### Tint assignment (one family per "product line")

| Line | Tint |
| --- | --- |
| Meetings (Dashboard) | sky |
| New Meeting | salmon |
| Meeting Detail | peach |
| Calendar | lime |
| Settings | periwinkle |
| Active Meeting | black frame (no tint: the recording is the CTA) |
| Mode: Speaker / Device / Mic + Device / File | sage / periwinkle / peach / steel |
| Status: completed / processing / failed | lime / yellow sticker / salmon |
| Model tiers S / A / B / C / D | yellow / lime / sky / peach / steel |

## 4. Screen plan

1. **Shell** – frame, black banner, white rail with icon-label nav, model chip,
   NEW! update sticker, seal; content column max 880 px.
2. **Dashboard** – sky eyebrow "My Meetings"; stats as three bordered catalog
   cells; search as a classic bordered input; meetings as ribbon rows (white
   title bar, mode-tinted body, square stickers); empty state as a ribbon card.
3. **New Meeting** – salmon eyebrow; source choices as ribbon cards tinted by
   mode, selected = thick frame + rotated "Selected" sticker; numbered fields;
   black **Start Recording**.
4. **Active Meeting** – black hero framed like the banner; Arial Black title,
   giant red timer (phone-callout scale), blinking square REC lamp (still under
   reduced motion); red **Stop & save** = the screen's only red CTA.
5. **Meeting Detail** – peach eyebrow with title; player as a framed ribbon
   card (black/steel waveform); transcript as a ruled list with blue underlined
   timestamps; export grid of square buttons; danger zone in salmon.
6. **Calendar** – lime eyebrow; 7-column grid of square bordered cells, today =
   yellow sticker number, selected = inverted, event marks = square swatches.
7. **Settings** – periwinkle eyebrow; tabs as folder tabs (active = black);
   tiers as ribbon cards with tint tier badges.

## 5. Deviations from DESIGN.md (functional, deliberate)

- **Red for errors/destructive.** The palette has no error colour; `--primary`
  is used as *text/border* for errors and destructive buttons. As a *fill* it
  stays reserved for the single red CTA and the phone-callout.
- **Hover/focus states.** DESIGN.md documents no hover; an app needs them.
  Hover = invert (black ⇄ white) or underline; focus = 2 px dotted black
  outline offset 2 px (keyboard a11y).
- **Light only.** The 1996 language has no dark mode; the app stays light.
- **Progress bars, waveform, sliders** are app-only primitives: black fill,
  1 px black track, no radius.
- **Bundled display font** (Archivo Black) where Arial Black is missing.

## 6. Verification

`npx tsc --noEmit` → `npx vitest run` → `npm run build && npx playwright test`
→ `npm run tauri:dev` for a visual pass on the real desktop shell.
