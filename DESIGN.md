# DESIGN.md — Local Transcribe design system

The single reference for every visual value in the app. If a value is not here,
it does not belong in a component.

**Rules**

1. **Tokens only.** Never hard-code a colour, font size, radius or spacing
   value in `styles.css` or in a component's inline `style`. Use the CSS custom
   properties defined in `:root` (`src/app/styles.css`).
2. **One spacing scale.** All margins, paddings and gaps come from
   `--space-1…6`. No 6px, 10px, 14px, 18px one-offs.
3. **Cards own the vertical rhythm.** A `.card` always has
   `margin-bottom: var(--space-4)` and `:last-child` resets to `0`, so
   consecutive cards never touch and never double-space.
4. **Prefer utility classes over inline styles** (`.stack`, `.row`,
   `.card-title`, `.mt-*`, `.mb-0`). Inline `style` is a last resort.

---

## 1. Design tokens

Declared in `:root` in `src/app/styles.css`. `--radius` is a legacy alias for
`--radius-md`; keep using the explicit names in new code.

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#edf1f7` | Page background |
| `--surface` | `#ffffff` | Cards, inputs, buttons |
| `--ink` | `#0f172a` | Primary text |
| `--muted` | `#64748b` | Secondary text |
| `--faint` | `#94a3b8` | Icons, chevrons, hints |
| `--border` | `#e2e8f0` | Default borders, dividers |
| `--border-strong` | `#cbd5e1` | Hover borders |
| `--hover` | `#f1f5f9` | Hover background |
| `--brand` | `#4f46e5` | Primary actions, links, focus |
| `--brand-dark` | `#4338ca` | Primary hover |
| `--brand-tint` | `#eef2ff` | Selected/active surface |
| `--danger` | `#dc2626` | Errors, destructive |
| `--danger-tint` | `#fef2f2` | Destructive hover |
| `--ok` | `#15803d` | Success text |
| `--ok-tint` | `#dcfce7` | Success surface |
| `--warn` | `#b45309` | Warnings |
| `--warn-tint` | `#fef9c3` | Warning surface |
| `--sidebar` | `#0b1120` | Sidebar / mobile bar / recording hero |
| `--sidebar-ink` | `#e2e8f0` | Text on dark |
| `--sidebar-muted` | `#64748b` | Muted text on dark |

Category colours (only used by pills/badges/tier badges):

| Meaning | Bg | Text | Border |
| --- | --- | --- | --- |
| Speaker / info | `#eff6ff` | `#1d4ed8` | `#bfdbfe` |
| Device | `#f5f3ff` | `#6d28d9` | `#ddd6fe` |
| Two-way | `#ecfdf5` | `#047857` | `#a7f3d0` |
| Processing / warn | `--warn-tint` | `--warn` | `#fde68a` |
| Completed / ok | `--ok-tint` | `--ok` | `#bbf7d0` |
| Failed / danger | `#fee2e2` | `--danger` | `#fecaca` |

### Spacing (4px base)

| Token | Value |
| --- | --- |
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |

Typical use: `1` icon gaps and tight label→value, `2` button gaps and list item
gaps, `3` grid gaps and card inner groups, `4` card padding, card-to-card gap
and section gap, `5` page padding / section breaks, `6` page top padding.

### Radii

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | `10px` | Buttons, inputs, transcript rows, badges' square art |
| `--radius-md` | `14px` | Cards, stats, meeting items, banners |
| `--radius-lg` | `20px` | App mark, recording hero, empty art |
| `--radius-pill` | `999px` | Pills and badges |

### Typography

Font: system UI sans (`ui-sans-serif, system-ui, …`); monospace
(`ui-monospace, "SF Mono", Menlo`) only for timers and transcript timestamps.

| Token | Value | Use |
| --- | --- | --- |
| `--text-xs` | `0.72rem` | Uppercase micro-labels (stat keys, nav label, badges use `0.68rem`) |
| `--text-sm` | `0.82rem` | Meta lines, helper text |
| `--text-md` | `0.92rem` | Body / default UI text |
| `--text-lg` | `1.05rem` | Section headings (`h2`) |
| `--text-xl` | `1.35rem` | Mobile `h1` |
| `--text-2xl` | `1.65rem` | Page title (`h1`) |

Weights used: 600–650 UI labels/buttons, 700 emphasis, 800 headings/numbers.

### Elevation & focus

| Token | Value |
| --- | --- |
| `--shadow` | `0 1px 2px rgb(15 23 42 / .06), 0 4px 16px -4px rgb(15 23 42 / .08)` |
| `--shadow-focus` | `0 0 0 3px rgb(79 70 229 / .15)` |

---

## 2. Layout

- `.layout` — flex row, `min-height: 100vh`.
- `.sidebar` — `264px` fixed, sticky, dark (`--sidebar`), hidden ≤ 820px.
- `.mobilebar` — hidden > 820px; sticky dark bar with brand + nav.
- `.main` — flex 1, `min-width: 0`.
- `.container` — `max-width: 840px`, centred, `padding: var(--space-6) var(--space-5) 90px`.

Screen skeleton: `.page-head` (title + description + actions) → one or more
`.card` sections. `.page-head` is `align-items: flex-end`,
`gap/margin-bottom: var(--space-4)`.

---

## 3. Components

### Card — `.card`
`background: --surface`, `1px --border`, `--radius-md`, `padding: var(--space-4)`,
`--shadow`, `margin-bottom: var(--space-4)`. Child resets: `> :first-child
margin-top: 0`, `> :last-child margin-bottom: 0`, `:last-child margin-bottom: 0`.
Variants: `.tier-card` (`padding: 0`, `overflow: hidden`, `margin-bottom:
var(--space-3)`), `.danger-zone` (danger border + `#fff7f7`), `.player-card`
(`padding: var(--space-3) var(--space-4)`), `.loader` (same footprint as a card).

### Buttons — `.btn`
`1px --border`, `--radius-sm`, `padding: 9px 16px`, `font-size: --text-md`,
weight 650, inline-flex with `gap: var(--space-2)`. Transitions
`background .12s, border-color .12s, transform .05s`; hover
`--hover`/`--border-strong`; active `translateY(1px)`; disabled `opacity: .55`.

- `.btn-primary` — `--brand` bg, white text; hover `--brand-dark`.
- `.btn-danger` — danger text, `#fecaca` border; hover `--danger-tint`.
- `.btn-lg` — `padding: 13px 22px`, `1rem`, `12px` radius.
- `.btn-stop` — full red (`#ef4444`) primary.
- `.btn-ghostlight` — transparent on dark, white text.
- `.link-btn` — borderless underlined brand text.
- `.btn-row` — flex wrap, `gap: var(--space-2)`, `margin-top: var(--space-3)`.
  Use it for every group of buttons.

### Inputs — `.input`
Full width, `padding: 11px 14px`, `0.95rem`, `1px --border`, `10px` radius;
focus `border-color: --brand` + `outline: 2px solid rgb(79 70 229 / .25)`.
`.search-wrap` adds a leading icon (input `padding-left: 38px`).

### Pill — `.pill`
`0.74rem`, weight 700, `padding: 3px 10px`, `--radius-pill`, `1px` border.
Modifiers `.pill-speaker|device|dual|file|processing|completed|failed` use the
category colours above (`.pill-file` = neutral slate, for imported audio).

### Badge — `.badge`
`0.68rem`, weight 800, uppercase, `letter-spacing: .04em`, `padding: 2px 8px`,
`--radius-pill`; embedded `svg` is `12×12`. Modifiers `.badge-rec`
(brand tint), `.badge-ok` (ok tint), `.badge-active` (solid brand).

### Tier card — `.tier-card` / `.tier-head` / `.tier-badge`
Group rows by tier (S–D) via `groupByTier`. Header `padding: 14px 16px`,
`gap: 12px`; `.tier-badge` is `34×34`, `10px` radius, weight 800, with
`.tier-S…D` colour pairs. Collapsible tiers use `<details>` whose `summary` is
the header (`[open]` adds a bottom border).

### Model row — `.model-row`
`padding: 12px 16px`, `gap: 12px`; `+ .model-row` gets a top border; `.active`
gets `--brand-tint`. `.model-main` (flex 1) holds `.model-title` (wrap, gap 8)
and a `.muted .small` meta line; `.model-actions` is `flex: none` with
`gap: 8px`.

### Meeting item — `.meeting-item`
Flex, `gap: 14px`, `padding: 14px 16px`, `--radius-md`, `--shadow`; hover border
`#a5b4fc`, active `translateY(1px)`. Children: `.body` (flex 1) → `.title`
(ellipsised) + `.meta` (`--text-sm`), `.pills` (`margin-left: auto`, gap 6),
`.chev` (`--faint`).

### Source card (New Meeting) — `.source-card`
2px border, `--radius-md`, `padding: 18px 16px`, `--shadow`; hover `#a5b4fc`;
`.selected` border `--brand` + `--shadow-focus`. `.icon` is `44×44`, `12px`
radius, brand tint (solid brand when selected).

### Stat — `.stat` / `.stats`
Grid of equal columns, `gap: var(--space-3)`, `margin-bottom: var(--space-4)`.
`.stat` = card-like at `padding: var(--space-3) var(--space-4)`; `.k` is
uppercase `--text-xs`; `.v` is `1.5rem`/800.

### Transcript — `.transcript`
Rows: `padding: 10px 12px`, `--text-md`, line-height 1.5, `1px --border`,
`10px` radius, `margin-bottom: 6px`. `.ts` is monospace brand-tinted; `.who` is
uppercase, `#047857`, `--text-sm`.

### Player — `.player-card`, `.player-stack`, `.track-player`
Single track: one `audio.player` (width 100%). Multiple tracks: `.player-stack`
(column, gap 10) with `.track-player` rows (flex, gap 10) and a `.track-label`
(`min-width: 62px`, uppercase, `--faint`-adjacent muted).

### Loader — `.loader` / `.spinner` / `progress`
Loader is a card-like block with `.loader-head` (flex, gap 10), a `.spinner`
(`20×20`, 3px border, brand top, spin 0.8s), and a `progress` bar
(`height: 10px`, `accent-color: --brand`). Show it while
`transcriptionStatus === 'processing'`.

### Banner / empty
`.banner` — warn border `#fcd34d` on `#fffbeb`, card radius/padding/shadow.
`.empty` — centred, `padding: 36px 20px`, with a `64×64` brand-tint `.art`.

---

## 4. Utilities

`.stack` (column, gap `--space-3`) · `.row` (row, centred, gap `--space-2`) ·
`.card-title` (row, wrap, gap `--space-2`, `margin-bottom: --space-1`) ·
`.mt-0 .mb-0 .mt-2 .mt-3 .mt-4`.

Use these instead of inline margins. If you need a value that isn't on the
scale, the design is wrong — pick the nearest step or add a token here.

---

## 5. Motion

- Transitions: `0.12s` for background/border/colour; `0.05s` for press
  transforms.
- Keyframes: `orb` (recording pulse, 1.6s), `spin` (loader, 0.8s), `pulse`
  (live dot / working dot).
- Respect `prefers-reduced-motion`: decoration is optional; never gate
  functionality on an animation.

---

## 6. Responsive

Single breakpoint: **`@media (max-width: 820px)`**.

- `.layout` becomes `display: block`; the sidebar is hidden and `.mobilebar`
  shows.
- `.container` padding `20px 14px 70px`; `h1` → `1.35rem`; `.page-head`
  stacks.
- `.source-grid`, stats, meeting items, model rows and the CTA all collapse to
  full-width / wrapped layouts; `.export-grid` becomes 2 columns.
- Any new multi-column block must be checked at 390px width for horizontal
  overflow.

---

## 7. Accessibility

- Focus: `:focus-visible` → `outline: 2px solid var(--brand); outline-offset: 2px`
  on buttons, links, inputs and `[tabindex]`.
- Status text uses `role="status"` (loader) / `role="alert"` (errors, warnings).
- Icon-only controls get `aria-label`; selects get explicit labels.
- Minimum body text `--text-md`; never smaller than `--text-xs` for real content.
- Colour is never the only signal (text/labels accompany pills and badges).

---

## 8. Checklist when adding UI

1. Compose from `.card` sections — do not invent spacing between them; they
   self-space.
2. Use `.btn-row` for buttons, `.row`/`.stack` for layout, `.mt-*` only if a
   utility is genuinely needed.
3. Use existing components (pill, badge, meeting-item, model-row, loader)
   before adding new CSS.
4. Any new value must be a token in `:root` **and** documented here.
5. Verify: `npx tsc --noEmit`, `npx vitest run`, `npm run build`,
   `npx playwright test`, and eyeball 390px + 1280px.
