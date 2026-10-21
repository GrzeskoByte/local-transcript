import { useState } from 'react';

interface Props {
  /** Button label before the user is asked. */
  children: React.ReactNode;
  /** The question shown once the button is pressed. */
  prompt: string;
  /** Label of the button that carries the action out. */
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  /** Skip the question and act right away (e.g. nothing would be lost). */
  skipConfirm?: boolean;
  disabled?: boolean;
}

/**
 * Two-step button. The webview does not show `window.confirm` (it silently
 * returns false), so the question is asked in the page instead.
 */
export function ConfirmButton({
  children, prompt, confirmLabel, onConfirm, className = 'btn', skipConfirm = false, disabled,
}: Props): React.JSX.Element {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => (skipConfirm ? onConfirm() : setAsking(true))}
      >
        {children}
      </button>
    );
  }
  return (
    <span className="btn-row" role="group" aria-label={prompt} onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}>
      <strong>{prompt}</strong>
      <button
        type="button"
        className={className}
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-ghostlight" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
