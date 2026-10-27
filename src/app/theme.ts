/**
 * Appearance (Settings → Appearance): brand + accent colour, shadow depth,
 * halftone texture and motion. Stored as one JSON pref (`appearance`) and
 * applied as CSS variables / classes on <html>, overriding the defaults in
 * styles.css :root. Pure helpers are exported for tests.
 */
import { getPref, setPref } from '../platform/prefs';

export interface Appearance {
  brand: string;
  accent: string;
  /** Multiplier for the hard offset shadows (0 = flat). */
  depth: number;
  halftone: boolean;
  motion: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  brand: '#f48ca8',
  accent: '#ff4e7e',
  depth: 1,
  halftone: true,
  motion: true,
};

export const BRAND_SWATCHES: ReadonlyArray<[string, string]> = [
  ['#f48ca8', 'Pink'],
  ['#ffd23f', 'Sunflower'],
  ['#9fd3ff', 'Sky'],
  ['#c9f27c', 'Lime'],
  ['#c4b0ff', 'Lilac'],
  ['#ffb38a', 'Peach'],
];

export const ACCENT_SWATCHES: ReadonlyArray<[string, string]> = [
  ['#ff4e7e', 'Hot pink'],
  ['#ff6a3d', 'Orange'],
  ['#2f6bff', 'Blue'],
  ['#00b37a', 'Green'],
  ['#a35cff', 'Violet'],
  ['#ffb000', 'Amber'],
];

export const PRESETS: ReadonlyArray<{ name: string; brand: string; accent: string }> = [
  { name: 'Halftone', brand: '#f48ca8', accent: '#ff4e7e' },
  { name: 'Sunflower', brand: '#ffd23f', accent: '#ff6a3d' },
  { name: 'Harbour', brand: '#9fd3ff', accent: '#2f6bff' },
  { name: 'Meadow', brand: '#c9f27c', accent: '#00b37a' },
];

const PREF = 'appearance';

export function isHex(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v);
}

/** Move each channel of `hex` towards `target` (0 or 255) by `k` (0..1). */
export function mix(hex: string, target: number, k: number): string {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    out += Math.round(v + (target - v) * k).toString(16).padStart(2, '0');
  }
  return out;
}

function luminance(hex: string): number {
  const c = [0, 1, 2].map((i) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** The text colour (black or white) with the best contrast on `hex`, and its ratio. */
export function textOn(hex: string): { color: '#000000' | '#ffffff'; ratio: number } {
  const l = luminance(hex);
  const onBlack = (l + 0.05) / 0.05;
  const onWhite = 1.05 / (l + 0.05);
  return onBlack >= onWhite ? { color: '#000000', ratio: onBlack } : { color: '#ffffff', ratio: onWhite };
}

/** CSS variables for an appearance (brand-derived dots/wash, text on the accent). */
export function themeVars(a: Appearance): Record<string, string> {
  const brand = a.brand.toLowerCase();
  const isDefault = brand === DEFAULT_APPEARANCE.brand;
  return {
    '--pink': brand,
    '--pink-deep': isDefault ? '#d6336c' : mix(brand, 0, 0.38),
    '--pink-wash': isDefault ? '#fff3f6' : mix(brand, 255, 0.9),
    '--hot': a.accent.toLowerCase(),
    '--on-hot': textOn(a.accent).color,
    '--sk': `${a.depth}px`,
  };
}

export function normalizeAppearance(raw: unknown): Appearance {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Appearance>;
  const depth = typeof v.depth === 'number' && Number.isFinite(v.depth) ? Math.min(2, Math.max(0, v.depth)) : 1;
  return {
    brand: typeof v.brand === 'string' && isHex(v.brand) ? v.brand.toLowerCase() : DEFAULT_APPEARANCE.brand,
    accent: typeof v.accent === 'string' && isHex(v.accent) ? v.accent.toLowerCase() : DEFAULT_APPEARANCE.accent,
    depth,
    halftone: v.halftone !== false,
    motion: v.motion !== false,
  };
}

export function loadAppearance(): Appearance {
  try {
    return normalizeAppearance(JSON.parse(getPref(PREF) ?? 'null'));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(themeVars(a))) root.style.setProperty(k, v);
  root.classList.toggle('noht', !a.halftone);
  root.classList.toggle('still', !a.motion);
}

export function saveAppearance(a: Appearance): void {
  setPref(PREF, JSON.stringify(a));
  applyAppearance(a);
}
