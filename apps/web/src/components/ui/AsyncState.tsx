import { useId, type ReactNode } from 'react';

import { toUserErrorMessage } from '../../api/error-message.js';
import { Button } from './Button.js';

export function LoadingState({ label = 'Memuat data…' }: Readonly<{ label?: string }>) {
  return (
    <div className="ds-state" role="status" aria-live="polite" aria-busy="true">
      <span className="ds-spinner ds-spinner--large" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: Readonly<{ title: string; description: string; action?: ReactNode }>) {
  const titleId = useId();
  return (
    <section className="ds-state ds-state--empty" aria-labelledby={titleId}>
      <span className="ds-state__icon" aria-hidden="true">
        ◌
      </span>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Data belum dapat dimuat',
}: Readonly<{ error: unknown; onRetry?: () => void; title?: string }>) {
  return (
    <section className="ds-state ds-state--error" role="alert" aria-live="assertive">
      <span className="ds-state__icon" aria-hidden="true">
        !
      </span>
      <h2>{title}</h2>
      <p>{toUserErrorMessage(error)}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="secondary">
          Coba lagi
        </Button>
      )}
    </section>
  );
}
