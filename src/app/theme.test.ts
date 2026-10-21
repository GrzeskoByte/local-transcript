import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, mix, normalizeAppearance, textOn, themeVars } from './theme';

describe('appearance theme', () => {
  it('keeps the design-system tokens for the default pair', () => {
    expect(themeVars(DEFAULT_APPEARANCE)).toEqual({
      '--pink': '#f48ca8',
      '--pink-deep': '#d6336c',
      '--pink-wash': '#fff3f6',
      '--hot': '#ff4e7e',
      '--on-hot': '#000000',
      '--sk': '1px',
    });
  });

  it('derives dots and wash from a custom brand', () => {
    const v = themeVars({ ...DEFAULT_APPEARANCE, brand: '#9fd3ff' });
    expect(v['--pink-deep']).toBe(mix('#9fd3ff', 0, 0.38));
    expect(v['--pink-wash']).toBe(mix('#9fd3ff', 255, 0.9));
  });

  it('switches text on the accent to white when black would fail', () => {
    expect(textOn('#ff4e7e').color).toBe('#000000');
    expect(textOn('#1a1a8a').color).toBe('#ffffff');
    expect(textOn('#1a1a8a').ratio).toBeGreaterThan(4.5);
  });

  it('normalizes stored values', () => {
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ brand: 'red', accent: '#2F6BFF', depth: 9, halftone: false })).toEqual({
      ...DEFAULT_APPEARANCE,
      accent: '#2f6bff',
      depth: 2,
      halftone: false,
    });
  });
});
