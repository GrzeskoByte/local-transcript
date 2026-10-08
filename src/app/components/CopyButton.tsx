import { useEffect, useState } from 'react';
import type React from 'react';

/** Small "Copy" button; `text` is built only when clicked (long transcripts). */
export function CopyButton({ label, text }: { label: string; text: () => string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-label={label}
      title={label}
      onClick={() => {
        const write = navigator.clipboard?.writeText(text());
        if (!write) return setState('failed');
        write.then(() => setState('copied')).catch(() => setState('failed'));
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
