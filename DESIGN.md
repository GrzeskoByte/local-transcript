---
version: 1
name: Halftone Window
description: Local Transcriber's design language — framed "windows" with black title bars and three dots on a dotted desk, a pink brand field with masked halftone dots, one hot-pink accent, Archivo Black display caps over JetBrains Mono everything-else, square corners, and hard offset ink shadows that the element presses into.
source: https://claude.ai/artifact/MLbt9MVbgpNdugGe58nKuh (canvas "Local Transcriber — redesign proposal", design system "Halftone Window")

colors:
  pink: "#f48ca8"        # brand field: page heads, open/hovered rows, paused REC. Text on it: ink only (9.2:1)
  pink-2: "#ec809c"      # pressed pink
  pink-deep: "#d6336c"   # halftone dots on pink only. Never text
  pink-wash: "#fff3f6"   # focused input, active transcript line, current model row
  hot: "#ff4e7e"         # THE accent: one primary action per screen, REC lamp, slider thumbs, focus ring. Text on it: ink (6.6:1), never paper
  berry: "#c2185b"       # accent as TEXT on paper (5.9:1) / panel (5.0:1): timestamps, links, errors, [ ] marks. Fails on pink
  ink: "#000000"         # frames, title bars, primary buttons, recording field, body text
  paper: "#ffffff"       # window bodies, inputs, the desk
  panel: "#eeedef"       # grey windows, tool-screen heads (Settings, Calendar), table heads
  mute: "#5c5a60"        # secondary text on paper/panel only; fails on pink
  faint: "#8a8790"       # placeholders and disabled controls only
  rule: "#d6d3d9"        # row dividers inside windows; the desk's dot grid
  rule-deep: "#c9c6cc"   # halftone dots on panel; waveform rest bars
  ink-soft: "#d8d6db"    # secondary text on ink

typography:
  display: { fontFamily: "Archivo Black", fallback: "Arial Black, Impact, sans-serif", fontWeight: 400, transform: uppercase }
  mono: { fontFamily: "JetBrains Mono", fallback: "ui-monospace, Menlo, Consolas, monospace" }
  mega: { family: display, fontSize: "clamp(40px, 6.4vw, 76px)", lineHeight: 0.86, letterSpacing: "-0.025em" }   # screen titles in page heads
  timer: { family: display, fontSize: 124px, lineHeight: 0.85, letterSpacing: "-0.03em" }                     # recording timer, tabular
  h1: { family: display, fontSize: 30px, lineHeight: 0.95 }    # empty-state titles, rename input
  h2: { family: display, fontSize: 22px, lineHeight: 1 }       # section heads (TODAY, TRANSCRIPT, MODELS)
  row-title: { family: display, fontSize: 19px, lineHeight: 1.1 }  # meeting titles in rows, one line, ellipsis
  stat: { family: display, fontSize: 44px, lineHeight: 1 }     # big numbers, tier letters (28px), calendar days (15px)
  h3: { family: mono, fontSize: 15px, fontWeight: 800 }        # card and item headings, sentence case
  body: { family: mono, fontSize: 14px, lineHeight: 1.6 }      # all running text and transcript lines
  lede: { family: mono, fontSize: 15px, fontWeight: 500 }      # page-head subtitle
  body-sm: { family: mono, fontSize: 12.5px, fontWeight: 500 } # meta lines, hints, timestamps (800, berry)
  label: { family: mono, fontSize: 13px, fontWeight: 700 }     # field labels, tabs, title-bar text (600)
  button: { family: mono, fontSize: 14px, fontWeight: 700 }    # buttons and nav, sentence case
  caption: { family: mono, fontSize: 11.5px, fontWeight: 700 } # tags, chips, weekday heads

spacing: { 2xs: 4px, xs: 6px, sm: 8px, md: 12px, lg: 16px, xl: 18px, 2xl: 24px, 3xl: 32px, section: 48px }
radius: { none: 0, dot: "50%" }   # dot = the three title-bar dots and the REC lamp only
shadow:                            # hard offset ink, never blurred; pressing moves the element into it; on ink fields the shadow is paper
  sm: "4px 4px 0 #000"   # primary buttons, small tiles
  md: "5px 5px 0 #000"   # large buttons, row hover lift, menus
  lg: "7px 7px 0 #000"   # page head, selected source card, toasts
  xl: "9px 9px 0 #000"   # the one hero window of a screen (recording field)
stroke:
  frame-line: "2px solid #000"     # windows, buttons, inputs, nav cells
  heavy-line: "3px solid #000"     # the one emphasised window in a group
  rule-line: "1.5px solid #d6d3d9" # rows inside a window
size: { bar-h: 36px, top-h: 52px, control-h: 44px, button: 40px, button-lg: 52px, button-sm: 30px }
---

# Halftone Window

## Overview

A desktop meeting recorder that looks like a stack of little windows on a
dotted desk. Every box is framed in 2 px ink; important boxes carry a black
title bar with three white dots. One pink brand field (with halftone dots that
fade out through a radial mask) heads each screen. One hot accent marks the
single thing to do next. Display caps are Archivo Black; everything else is
JetBrains Mono, so timestamps, sizes and model names line up.

The theme is user-adjustable (Settings → Appearance): brand and accent can be
swapped as a pair (Halftone, Sunflower, Harbour, Meadow presets or any hex),
shadow depth scales 0–2×, halftone and motion can be turned off. Every rule
below is written against the *roles* (`pink`, `hot`, …), not the hexes.

## Colors

- **Ink on everything.** Body text is ink on paper, panel, pink and hot.
  `mute` only on paper/panel; `berry` is the accent *as text* (timestamps,
  links, errors) and never sits on pink.
- **Pink = brand field.** Page heads, hovered/open rows, the paused REC cell,
  `mark` highlights. Never text.
- **Hot = the one accent.** At most one hot primary action per screen
  (**● Record**, **Stop & save**), plus the REC lamp, focus ring, slider thumbs
  and the danger title bar. Text on hot is ink (Appearance flips it to white
  when a darker accent would fail AA).
- **Panel = tools.** Settings and Calendar heads are panel, not pink; so are
  table heads and action bars at the foot of a window.
- **Pink-wash = "this one".** Focused input, active transcript line, current
  model row — always with a 6 px hot inset bar on the left.

## Typography

- Screen titles: `mega`, uppercase, tight leading, in the page head only.
- Section heads (`h2`): Archivo Black 22 px caps above a group of windows.
- Meeting titles in rows: Archivo Black 19 px caps, one line, ellipsis.
- Everything else is JetBrains Mono in sentence case: card headings 15/800,
  body 14/400 at 1.6, labels 13/700, meta 12.5/500, tags 11.5/700.
- Tabular figures for timers, durations, percentages and calendar numbers.
- Status words are written as checkboxes: `[x] transcribed`, `[ ] not
  transcribed`, `[!] failed`, `[~]` working.

## Layout

- **Desk:** paper with a 14 px dot grid (`rule`).
- **Nav window** on top (52 px, framed, sticky): black brand cell
  (dots + `local-transcriber`), section links (active = ink with a 4 px hot
  underline), a 6 px halftone filler, status cells (background transcription,
  update, model `[x] …`), and at the far right the hot **● Record `Ctrl N`**
  cell — replaced by the ink **● REC 12:34** cell while recording.
- **Content** column max 1408 px for the shell, 1120 px for screens.
- **Footer**: black band, `[x]` in pink, the privacy line.
- Rhythm: page head → content 32 px; windows 24 px apart; window body
  16 × 18 px; label → control 8 px; control → hint 6 px; group → group 18 px.
- Phone width: the nav window scrolls sideways, page heads stack, meeting
  rows drop their tags under the title, no horizontal page scroll.

## Elevation & Depth

Hard ink offsets only (`sh-sm`…`sh-xl`), never blurred. A button presses
*into* its shadow (`translate` by the offset, shadow to none). Rows lift on
hover (−3 px, `sh-md`). On the ink recording field the Stop button's shadow is
paper. Shadow depth is a user setting (`--sk`).

## Shapes

Square everything: windows, buttons, inputs, tags, tiles, selects (the select
arrow is a 36 px ink block). Round only for the three title-bar dots, the REC
lamp and radio buttons.

## Components

### Window (`.card`)
2 px frame, paper body. Its first `strong` / `.model-title` / `.card-title`
is the **title bar**: ink, 36 px, three paper dots, 13 px/600 mono text;
buttons in it are transparent with a 1.5 px paper border. A collapsed
section is its title bar only. The danger window's bar is hot.

### Page head (`.page-head`)
Pink field (panel for tool screens: `.is-tool`), 2 px frame, `sh-lg`, 48 px
top padding, mega title + 15 px lede; halftone dots in `pink-deep` masked
from the top-right. Actions sit bottom-right.

### Buttons (`.btn`)
40 px, 2 px frame, mono 14/700, sentence case. Hover = pink. Primary = ink
with `sh-sm`, hover = hot. Large = 52 px with `sh-md`. Small = 30 px.
Disabled = faint border + hatched fill. Danger = berry text, hover hot.

### Tags (`.pill`)
1.5 px ink border, 11.5/700. Source glyphs: ● room mic, ▣ device, ◐ call,
▤ file. Status: `[x]` ink fill (done), pink with a blinking dot (working),
`[!]` hot (failed), `[ ]` berry (not started).

### Meeting row (`.meeting-item`)
Framed paper row, 76 px: caps title over a mute meta line, tags, and a 56 px
ink chevron block. Hover = pink + lift; the chevron turns hot.

### Tabs (`.tabs`)
One framed strip of cells divided by 2 px rules; active = ink with a 4 px hot
underline.

### Fields
44 px, 2 px frame, mono 14. Focus = pink-wash fill + 4 px hot offset shadow
(no outline). Checkboxes are 18 px squares, checked = ink with a paper inset.

### Tier module (Settings models)
Framed block; 64 px ink badge with the tier letter (S = hot); open = pink
header with a 2 px rule; `+`/`−` square toggle. Model rows ruled; the
current one pink-wash with the hot inset bar.

### Recording field (`.rec-hero`)
Ink window with `sh-xl` and hot halftone; pink source tag; caps title; a paper
rule; hot round lamp + 124 px paper timer; Pause as ink-on-ink with a paper
border; **Stop & save** hot with a paper shadow.

### Transcript (`.transcript`)
Framed list, rows ruled with `rule-line`; timestamps berry 12.5/800 tabular;
the playing line pink-wash with the hot inset bar; search hits in pink `mark`.

### Toasts
Framed paper with a 12 px left bar (ink for notices, hot for errors), `sh-lg`.

## Do's and Don'ts

### Do
- Frame every box; rule rows inside a box.
- Keep one hot primary action per screen.
- Write statuses as `[x]` / `[ ]` / `[!]`.
- Read every colour from a token; let Appearance re-theme it.
- Keep text ≥ 4.5:1 — ink on pink/hot, mute only on paper/panel.

### Don't
- No rounded corners (except dots, lamp, radios), no blurred shadows, no
  gradients other than the masked halftone dots.
- Never put paper text on hot, or berry/mute text on pink.
- Never use pink-deep or faint for running text.
- No emoji; glyphs are the mono set (● ▣ ◐ ▤ ✚ › ↑).
