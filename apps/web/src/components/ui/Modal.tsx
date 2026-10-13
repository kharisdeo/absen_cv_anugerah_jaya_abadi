import { useEffect, useId, useRef, type ReactNode } from 'react';

import { Button } from './Button.js';

export function Modal({
  open,
  title,
  description,
  onOpenChange,
  children,
  closeLabel = 'Tutup dialog',
}: Readonly<{
  open: boolean;
  title: string;
  description?: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  closeLabel?: string;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="ds-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className="ds-dialog__content">
        <header className="ds-dialog__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <Button
            aria-label={closeLabel}
            className="ds-dialog__close"
            onClick={() => onOpenChange(false)}
            variant="quiet"
          >
            ×
          </Button>
        </header>
        <div className="ds-dialog__body">{children}</div>
      </div>
    </dialog>
  );
}
