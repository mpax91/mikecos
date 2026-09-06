import { useEffect } from 'react';

const AUTO_DISMISS_MS = 6000;

/** A small transient bottom-of-screen banner, optionally with an "Undo"
 * action — e.g. after moving a note to a project. Auto-dismisses on its own
 * so it never needs to be manually cleared for the common case of not
 * wanting to undo. */
export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="toast">
      <span className="toast__message">{message}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            onAction();
            onDismiss();
          }}
        >
          {actionLabel}
        </button>
      )}
      <button type="button" className="toast__close" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
