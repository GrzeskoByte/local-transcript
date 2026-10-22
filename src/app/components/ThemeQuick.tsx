import { useEffect, useState } from 'react';
import { Popover } from './Popover.tsx';
import { ACCENT_SWATCHES, BRAND_SWATCHES, loadAppearance, saveAppearance, type Appearance } from '../theme';
import { useApp } from '../store.tsx';

/** Nav window "Theme" cell: brand + accent swatches, and a link to Appearance. */
export function ThemeQuick(): React.JSX.Element {
  const { go } = useApp();
  const [open, setOpen] = useState(false);
  const [look, setLook] = useState<Appearance>(loadAppearance);

  useEffect(() => {
    if (open) setLook(loadAppearance());
  }, [open]);

  const pick = (patch: Partial<Appearance>) => {
    const next = { ...look, ...patch };
    setLook(next);
    saveAppearance(next);
  };

  return (
    <div className="theme-quick">
      <Popover
        role="dialog"
        label="Theme colours"
        align="end"
        open={open}
        onOpenChange={setOpen}
        className="card theme-pop"
        triggerClassName="cell theme-cell"
        trigger={
          <>
            <i className="theme-chip brand" aria-hidden="true" />
            <i className="theme-chip accent" aria-hidden="true" />
            Theme
          </>
        }
      >
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
      </Popover>
    </div>
  );
}
