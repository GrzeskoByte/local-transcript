import { useState } from 'react';
import {
  ACCENT_SWATCHES,
  BRAND_SWATCHES,
  DEFAULT_APPEARANCE,
  PRESETS,
  isHex,
  loadAppearance,
  saveAppearance,
  textOn,
  type Appearance,
} from '../theme';

/** Settings → Appearance: brand + accent colour, shadow depth, halftone, motion. */
export function AppearanceSettings(): React.JSX.Element {
  const [look, setLook] = useState<Appearance>(loadAppearance);
  const update = (patch: Partial<Appearance>): void => {
    const next = { ...look, ...patch };
    setLook(next);
    saveAppearance(next);
  };
  const onAccent = textOn(look.accent);

  return (
    <>
      <section className="card" aria-label="Presets">
        <strong>Presets</strong>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="preset"
              aria-pressed={look.brand === p.brand && look.accent === p.accent}
              onClick={() => update({ brand: p.brand, accent: p.accent })}
            >
              <span className="preset-chip" style={{ background: p.brand }} aria-hidden="true" />
              <span className="preset-chip" style={{ background: p.accent }} aria-hidden="true" />
              {p.name}
            </button>
          ))}
        </div>
      </section>

      <section className="card" aria-label="Colours">
        <strong>Colours</strong>
        <ColourPicker
          label="Brand colour"
          hint="Page heads, open and hovered rows. Text on it stays black."
          value={look.brand}
          swatches={BRAND_SWATCHES}
          onChange={(brand) => update({ brand })}
        />
        <ColourPicker
          label="Accent colour"
          hint="The one primary action per screen, the REC lamp, focus rings."
          value={look.accent}
          swatches={ACCENT_SWATCHES}
          onChange={(accent) => update({ accent })}
        />
        <p className="muted small mt-2 mb-0" role="status">
          {onAccent.ratio >= 4.5 ? '[x]' : '[!]'} Text on the accent is {onAccent.color === '#000000' ? 'black' : 'white'} ·
          contrast {onAccent.ratio.toFixed(1)}:1{onAccent.ratio >= 4.5 ? ' · passes AA' : ' · below AA, pick a stronger accent'}
        </p>
      </section>

      <section className="card" aria-label="Texture and motion">
        <strong>Texture &amp; motion</strong>
        <label className="field-label" htmlFor="shadow-depth">
          Shadow depth
        </label>
        <input
          id="shadow-depth"
          className="depth-range"
          type="range"
          min={0}
          max={2}
          step={0.25}
          value={look.depth}
          onChange={(e) => update({ depth: Number(e.target.value) })}
        />
        <div className="muted small">
          {look.depth === 0 ? 'Flat: no offset shadows.' : `${look.depth}× the standard hard shadow.`}
        </div>
        <label className="check-row">
          <input type="checkbox" checked={look.halftone} onChange={(e) => update({ halftone: e.target.checked })} />
          Halftone dots on page heads
        </label>
        <label className="check-row">
          <input type="checkbox" checked={look.motion} onChange={(e) => update({ motion: e.target.checked })} />
          Motion (blinking REC lamp, button press)
        </label>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => update({ ...DEFAULT_APPEARANCE })}>
            Reset to Halftone
          </button>
        </div>
      </section>
    </>
  );
}

function ColourPicker({
  label,
  hint,
  value,
  swatches,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  swatches: ReadonlyArray<[string, string]>;
  onChange: (hex: string) => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <fieldset className="colour-field">
      <legend className="field-label">{label}</legend>
      <div className="swatches" role="group" aria-label={label}>
        {swatches.map(([hex, name]) => (
          <button
            key={hex}
            type="button"
            className="swatch"
            style={{ background: hex }}
            aria-label={name}
            aria-pressed={value === hex}
            onClick={() => {
              setTyped(null);
              onChange(hex);
            }}
          >
            {value === hex ? 'x' : ''}
          </button>
        ))}
      </div>
      <div className="color-row">
        <input
          type="color"
          aria-label={`Pick any ${label.toLowerCase()}`}
          value={value}
          onChange={(e) => {
            setTyped(null);
            onChange(e.target.value.toLowerCase());
          }}
        />
        <input
          className="input"
          aria-label={`${label} hex`}
          value={typed ?? value}
          onChange={(e) => {
            let v = e.target.value.trim();
            if (v && !v.startsWith('#')) v = `#${v}`;
            if (isHex(v)) {
              setTyped(null);
              onChange(v.toLowerCase());
            } else setTyped(e.target.value);
          }}
        />
      </div>
      <div className="muted small">{hint}</div>
    </fieldset>
  );
}
