@AGENTS.md

## Design rule (UI changes)
- **`DESIGN.md` is the design reference for this project.** Before any UI change (CSS, markup, component, copy layout, new screen), read `DESIGN.md` and check the change against its tokens, components and Do's/Don'ts. If the change conflicts with it, follow `DESIGN.md` or ask first.
- `docs/REDESIGN.md` records how `DESIGN.md` maps onto this app (screen tints, which component plays the red CTA / phone-callout / sticker roles, functional deviations). Keep it in sync when you add a screen or a component.
- Tokens live in `:root` in `src/app/styles.css`; never hard-code a colour, font or radius in a component.
