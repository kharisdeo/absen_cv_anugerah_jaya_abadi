import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

export function Alert({
  tone = 'info',
  title,
  children,
}: Readonly<{ tone?: AlertTone; title?: string; children: ReactNode }>) {
  const urgent = tone === 'danger';
  return (
    <div
      className={`ds-alert ds-alert--${tone}`}
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
    >
      <span className="ds-alert__mark" aria-hidden="true">
        {tone === 'success' ? '✓' : tone === 'danger' ? '!' : tone === 'warning' ? '!' : 'i'}
      </span>
      <div className="ds-alert__body">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}
