import { useApp } from '../store.tsx';

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

/** Live progress for a speech-model download (one-time setup). */
export function ModelDownloadProgress(): React.JSX.Element | null {
  const { modelDownload } = useApp();
  if (!modelDownload) return null;
  const { received, total, name } = modelDownload;
  const ratio = total > 0 ? received / total : undefined;
  return (
    <div className="loader" role="status" aria-live="polite" aria-label="Downloading speech model">
      <div className="loader-head">
        <div className="spinner" aria-hidden="true" />
        <strong>Downloading speech model…</strong>
        <span className="muted">
          {ratio !== undefined ? `${Math.round(ratio * 100)}% · ${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`}
        </span>
      </div>
      {ratio !== undefined ? <progress max={1} value={ratio} /> : <progress />}
      <p className="muted small mb-0 mt-2">
        One-time setup ({name}). After this, transcription works offline.
      </p>
    </div>
  );
}
