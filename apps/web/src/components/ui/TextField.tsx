import { useId, type InputHTMLAttributes } from 'react';

export type TextFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> &
  Readonly<{
    id?: string;
    label: string;
    hint?: string;
    error?: string;
  }>;

export function TextField({ id, label, hint, error, required, ...inputProps }: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="ds-field">
      <label className="ds-field__label" htmlFor={fieldId}>
        {label}
        {required && (
          <span className="ds-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <input
        {...inputProps}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`ds-input${error ? ' ds-input--error' : ''}${inputProps.className ? ` ${inputProps.className}` : ''}`}
        id={fieldId}
        required={required}
      />
      {hint && (
        <span className="ds-field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="ds-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
