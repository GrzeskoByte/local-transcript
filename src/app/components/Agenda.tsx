import { useState } from 'react';
import {
  agendaTotalMinutes,
  newAgendaItem,
  parseAgendaText,
  type AgendaItem,
} from '../../domain/agenda';

/** Read-only numbered agenda. */
export function AgendaList({ items }: { items: AgendaItem[] }): React.JSX.Element {
  const total = agendaTotalMinutes(items);
  return (
    <>
      <ol className="agenda-list" aria-label="Agenda">
        {items.map((i) => (
          <li key={i.id}>
            <span className="agenda-title">{i.title}</span>
            {(i.owner || i.minutes) && (
              <span className="muted small">
                {' '}
                {[i.owner ? `@${i.owner}` : '', i.minutes ? `${i.minutes} min` : ''].filter(Boolean).join(' · ')}
              </span>
            )}
            {i.notes && <div className="muted small agenda-notes">{i.notes}</div>}
          </li>
        ))}
      </ol>
      {total > 0 && <p className="muted small mb-0">Planned: {total} min</p>}
    </>
  );
}

/** Controlled agenda editor: topics with optional owner, minutes and notes. */
export function AgendaEditor({
  items,
  onChange,
}: {
  items: AgendaItem[];
  onChange: (items: AgendaItem[]) => void;
}): React.JSX.Element {
  const [paste, setPaste] = useState<string | null>(null);
  const update = (id: string, patch: Partial<AgendaItem>): void =>
    onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const move = (index: number, delta: number): void => {
    const next = items.slice();
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  };
  const total = agendaTotalMinutes(items);

  return (
    <div className="agenda-editor">
      {items.length === 0 && <p className="muted small">No topics yet.</p>}
      {items.map((item, index) => (
        <div key={item.id} className="agenda-row" aria-label={`Agenda item ${index + 1}`}>
          <span className="agenda-num">{index + 1}.</span>
          <div className="agenda-fields">
            <input
              className="input"
              aria-label={`Topic ${index + 1}`}
              placeholder="Topic"
              value={item.title}
              maxLength={200}
              onChange={(e) => update(item.id, { title: e.target.value })}
            />
            <div className="agenda-meta">
              <input
                className="input"
                aria-label={`Owner of topic ${index + 1}`}
                placeholder="Owner (optional)"
                value={item.owner ?? ''}
                maxLength={60}
                onChange={(e) => update(item.id, { owner: e.target.value })}
              />
              <input
                className="input agenda-minutes"
                type="number"
                min={0}
                max={600}
                aria-label={`Minutes for topic ${index + 1}`}
                placeholder="min"
                value={item.minutes ?? ''}
                onChange={(e) =>
                  update(item.id, { minutes: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
            </div>
            <textarea
              className="input"
              rows={1}
              aria-label={`Notes for topic ${index + 1}`}
              placeholder="Notes (optional)"
              value={item.notes ?? ''}
              onChange={(e) => update(item.id, { notes: e.target.value })}
            />
          </div>
          <div className="agenda-actions">
            <button type="button" className="icon-btn" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Move down"
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove topic ${index + 1}`}
              onClick={() => onChange(items.filter((i) => i.id !== item.id))}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      {total > 0 && <p className="muted small mt-1 mb-0">Planned: {total} min</p>}

      {paste !== null && (
        <>
          <label className="field-label" htmlFor="agenda-paste">
            Paste a list — one topic per line (“Roadmap @anna 15 min”)
          </label>
          <textarea
            id="agenda-paste"
            className="input"
            rows={4}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
        </>
      )}
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => onChange([...items, newAgendaItem()])}>
          + Add topic
        </button>
        {paste === null ? (
          <button type="button" className="btn" onClick={() => setPaste('')}>
            Paste list…
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={!paste.trim()}
              onClick={() => {
                onChange([...items.filter((i) => i.title.trim()), ...parseAgendaText(paste)]);
                setPaste(null);
              }}
            >
              Add pasted topics
            </button>
            <button type="button" className="link-btn" onClick={() => setPaste(null)}>
              Cancel paste
            </button>
          </>
        )}
      </div>
    </div>
  );
}
