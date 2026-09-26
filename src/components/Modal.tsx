export function Modal({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  /** Extra class on the inner `.modal` box — for a modal that wants more
   * width than the default (see `.bets-workspace__notes-modal`). */
  className?: string;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={className ? `modal ${className}` : 'modal'} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3>{title}</h3>
          {/* Tapping the backdrop closes on desktop, but a tall modal (the
              Bets notes modal especially, with the handicapping panel
              added) can fill the whole mobile viewport and leave no
              backdrop showing to tap — this is the explicit close path
              for that case. */}
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
