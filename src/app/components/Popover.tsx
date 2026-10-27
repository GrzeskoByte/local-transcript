import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A popover rendered into <body> with fixed positioning, so no parent with
 * `overflow: hidden|auto` (page heads, cards, scrolling tables, the nav
 * window) can clip it. It opens below its trigger, flips above when there is
 * no room, stays inside the viewport, and closes on outside click, Escape,
 * scroll of an ancestor or resize.
 */
export function Popover({
  trigger,
  children,
  label,
  role = 'menu',
  align = 'start',
  className = '',
  triggerClassName = 'btn',
  open: controlled,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  label: string;
  role?: 'menu' | 'dialog';
  align?: 'start' | 'end';
  className?: string;
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = useCallback(
    (v: boolean) => {
      setOwn(v);
      onOpenChange?.(v);
    },
    [onOpenChange],
  );
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const gap = 6;
    const margin = 8;
    const w = p.offsetWidth;
    const h = p.scrollHeight;
    const below = window.innerHeight - b.bottom - gap - margin;
    const above = b.top - gap - margin;
    const up = h > below && above > below;
    const maxHeight = Math.max(120, up ? above : below);
    let left = align === 'end' ? b.right - w : b.left;
    left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
    const top = up ? Math.max(margin, b.top - gap - Math.min(h, maxHeight)) : b.bottom + gap;
    setPos({ top, left, maxHeight });
  }, [align]);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus();
      }
    };
    const onScroll = (e: Event): void => {
      if (!pop.current?.contains(e.target as Node)) place();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    // First item gets focus for keyboard users.
    requestAnimationFrame(() => pop.current?.querySelector<HTMLElement>('button:not(:disabled), input, select, a')?.focus());
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place, setOpen]);

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (role !== 'menu' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next?.focus();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${triggerClassName}${open ? ' is-open' : ''}`}
        aria-haspopup={role}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            className={`popover ${role === 'menu' ? 'menu-list' : ''} ${className}`.trim()}
            role={role}
            aria-label={label}
            onKeyDown={onMenuKey}
            style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { visibility: 'hidden', top: 0, left: 0 }}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body,
        )}
    </>
  );
}
