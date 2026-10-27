/**
 * Keyboard shortcuts (Settings → App & updates: click a key to change it).
 * A binding is "Ctrl+N", "P", "Space", "ArrowLeft"…; "Ctrl" also matches
 * Cmd on macOS.
 */
import { getPref, setPref } from '../platform/prefs';

export type ShortcutId = 'record' | 'pause' | 'moment' | 'play' | 'back' | 'forward' | 'search';

export const SHORTCUT_LABELS: Record<ShortcutId, string> = {
  record: 'New recording / back to the running one',
  pause: 'Pause / resume',
  moment: 'Mark a moment',
  play: 'Play / pause playback',
  back: 'Skip 15 s back',
  forward: 'Skip 15 s forward',
  search: 'Search everything',
};

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  record: 'Ctrl+N',
  pause: 'P',
  moment: 'M',
  play: 'Space',
  back: 'ArrowLeft',
  forward: 'ArrowRight',
  search: 'Ctrl+F',
};

const PREF = 'shortcuts';
const listeners = new Set<() => void>();

export function shortcuts(): Record<ShortcutId, string> {
  try {
    const saved = JSON.parse(getPref(PREF) ?? '{}') as Partial<Record<ShortcutId, string>>;
    return { ...DEFAULT_SHORTCUTS, ...saved };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function setShortcut(id: ShortcutId, binding: string): void {
  setPref(PREF, JSON.stringify({ ...shortcuts(), [id]: binding }));
  listeners.forEach((l) => l());
}

export function resetShortcuts(): void {
  setPref(PREF, '{}');
  listeners.forEach((l) => l());
}

export function subscribeShortcuts(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The binding a key press makes ("Ctrl+Shift+K"); null for a lone modifier. */
export function bindingOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return null;
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key]
    .filter(Boolean)
    .join('+');
}

export function matches(e: KeyboardEvent, binding: string): boolean {
  return bindingOf(e) === binding;
}

/** "Ctrl+N" → ["Ctrl", "N"]; arrows as glyphs, for <kbd>. */
export function keyParts(binding: string): string[] {
  return binding
    .split('+')
    .map((k) => ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' })[k] ?? k);
}

/** Typing in a field (or on a select) keeps its keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
