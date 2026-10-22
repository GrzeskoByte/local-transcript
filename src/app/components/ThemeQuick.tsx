import { useEffect, useRef, useState } from 'react';
import { ACCENT_SWATCHES, BRAND_SWATCHES, loadAppearance, saveAppearance, type Appearance } from '../theme';
import { useApp } from '../store.tsx';

/** Nav window "Theme" cell: brand + accent swatches, and a link to Appearance. */
export function ThemeQuick(): React.JSX.Element {
  const { go } = useApp();
  const [open, setOpen] = useState(false);
  const [look, setLook] = useState<Appearance>(loadAppearance);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLook(loadAppearance());
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (patch: Partial<Appearance>) => {
    const next = { ...look, ...patch };
    setLook(next);
    saveAppearance(next);
  };

  return (
    <div className="theme-quick" ref={ref}>
      <button
        type="button"
        className={`cell theme-cell${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Theme colours"
        onClick={() => setOpen((v) => !v)}
      >
        <i className="theme-chip brand" aria-hidden="true" />
        <i className="theme-chip accent" aria-hidden="true" />
        Theme
      </button>
      {open && (
        <section className="card theme-pop" role="dialog" aria-label="Theme colours">
          <div className="card-title">
            <strong>theme</strong>
            <button type="button" className="btn btn-sm" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <p className="qlbl">
            <span>Brand</span>
            <code>{look.brand}</code>
          </p>
          <div className="swatches" role="group" aria-label="Brand colour">
            {BRAND_SWATCHES.map(([hex, name]) => (
              <button
                key={hex}
                type="button"
                className="swatch"
                style={{ background: hex }}
                aria-label={name}
                aria-pressed={look.brand === hex}
                onClick={() => pick({ brand: hex })}
              >
                {look.brand === hex ? 'x' : ''}
              </button>
            ))}
          </div>
          <p className="qlbl">
            <span>Accent</span>
            <code>{look.accent}</code>
          </p>
          <div className="swatches" role="group" aria-label="Accent colour">
            {ACCENT_SWATCHES.map(([hex, name]) => (
              <button
                key={hex}
                type="button"
                className="swatch"
                style={{ background: hex }}
                aria-label={name}
                aria-pressed={look.accent === hex}
                onClick={() => pick({ accent: hex })}
              >
                {look.accent === hex ? 'x' : ''}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm mt-4"
            onClick={() => {
              setOpen(false);
              go({ name: 'settings', tab: 'appearance' });
            }}
          >
            Custom colours, presets, texture →
          </button>
        </section>
      )}
    </div>
  );
}
