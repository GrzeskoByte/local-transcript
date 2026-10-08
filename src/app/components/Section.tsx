/**
 * Collapsible ribbon card. Which sections are collapsed is one shared,
 * persisted set (pref `collapsed-sections`), so collapsing the agenda once
 * keeps it collapsed on every meeting, and Collapse all / Expand all reach
 * every open section at once.
 */
import { useSyncExternalStore } from 'react';
import type React from 'react';
import { getPref, setPref } from '../../platform/prefs';

const PREF = 'collapsed-sections';
const listeners = new Set<() => void>();
let collapsed: ReadonlySet<string> | null = null;

function load(): ReadonlySet<string> {
  if (collapsed) return collapsed;
  try {
    const raw = JSON.parse(getPref(PREF) ?? '[]') as unknown;
    collapsed = new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    collapsed = new Set();
  }
  return collapsed;
}

function save(next: Set<string>): void {
  collapsed = next;
  setPref(PREF, JSON.stringify([...next]));
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open or close sections by id. */
export function setSectionsOpen(ids: string[], open: boolean): void {
  const next = new Set(load());
  for (const id of ids) {
    if (open) next.delete(id);
    else next.add(id);
  }
  save(next);
}

/** Collapsed section ids (re-renders on change). */
export function useCollapsedSections(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, load, load);
}

/** Forget the cached set (tests). */
export function resetSectionsCache(): void {
  collapsed = null;
}

export function Section({
  id,
  title,
  label,
  badge,
  peek,
  actions,
  className,
  children,
}: {
  /** Stable id: persisted collapse state and the `sec-<id>` anchor. */
  id: string;
  title: string;
  /** Accessible region name (defaults to the title). */
  label?: string;
  badge?: React.ReactNode;
  /** One line shown in the title bar while collapsed (e.g. the TL;DR). */
  peek?: string;
  /** Buttons in the title bar (e.g. Copy), visible open or collapsed. */
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const open = !useCollapsedSections().has(id);
  const bodyId = `sec-${id}-body`;
  return (
    <section id={`sec-${id}`} className={`card collapsible${className ? ` ${className}` : ''}`} aria-label={label ?? title}>
      <div className="model-title">
        <button
          type="button"
          className="collapse-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? `Collapse ${title.toLowerCase()}` : `Expand ${title.toLowerCase()}`}
          onClick={() => setSectionsOpen([id], !open)}
        >
          <span className="collapse-mark" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <strong>{title}</strong>
        </button>
        {badge}
        {!open && peek && <span className="collapse-peek">{peek}</span>}
        {actions && <span className="collapse-actions">{actions}</span>}
      </div>
      <div id={bodyId} className="collapse-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
