import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';

import { toUserErrorMessage } from '../api/error-message.js';
import {
  attendanceRequestsApi,
  type AttendanceRequestCreateInput,
  type AttendanceRequestDto,
  type AttendanceRequestPage,
} from '../api/attendance-requests-api.js';
import { getRequestPresentation } from '../domain/attendance-state.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { TextField } from '../components/ui/TextField.js';
import {
  createRequestSubmissionGate,
  emptyEmployeeRequestDraft,
  EMPLOYEE_REQUEST_TYPE_OPTIONS,
  EmployeeRequestFormError,
  MAX_DOCTOR_NOTE_BYTES,
  toAttendanceRequestCreateInput,
  validateEmployeeRequestDraft,
  type EmployeeRequestDraft,
  type EmployeeRequestDraftErrors,
  type RequestFormType,
} from './employee-request-form.js';
import './employee-requests.css';

const REQUEST_PAGE_SIZE = 25;

export type RequestListState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; page: AttendanceRequestPage }>;

function requestTypeLabel(type: AttendanceRequestDto['requestType']): string {
  return EMPLOYEE_REQUEST_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(date);
}

function RequestStatus({ status }: Readonly<{ status: AttendanceRequestDto['status'] }>) {
  const presentation = getRequestPresentation(status);
  return (
    <span className={`ds-status ds-status--${presentation.tone}`}>
      <span className="ds-status__dot" aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

export function EmployeeRequestList({
  state,
  onRetry,
  onPageChange,
}: Readonly<{
  state: RequestListState;
  onRetry: () => void;
  onPageChange: (page: number) => void;
}>) {
  if (state.status === 'loading') return <LoadingState label="Memuat pengajuan Anda…" />;
  if (state.status === 'error') {
    return (
      <ErrorState error={state.error} onRetry={onRetry} title="Pengajuan belum dapat dimuat" />
    );
  }
  if (state.page.items.length === 0) {
    return (
      <EmptyState
        title="Belum ada pengajuan"
        description="Pengajuan yang Anda kirim akan muncul di sini. Tidak ada saldo cuti yang disimpulkan dari daftar ini."
      />
    );
  }

  return (
    <div className="employee-request-list">
      <ul className="employee-request-list__items" aria-label="Daftar pengajuan pribadi">
        {state.page.items.map((request) => (
          <li className="employee-request-card" key={request.id}>
            <div className="employee-request-card__header">
              <div>
                <span className="section-kicker">PENGAJUAN KARYAWAN</span>
                <h3>{requestTypeLabel(request.requestType)}</h3>
              </div>
              <RequestStatus status={request.status} />
            </div>
            <dl className="employee-request-card__details">
              <div>
                <dt>Rentang tanggal</dt>
                <dd>
                  {formatDate(request.startDate)}
                  {request.startDate !== request.endDate && <> – {formatDate(request.endDate)}</>}
                </dd>
              </div>
              <div>
                <dt>Alasan</dt>
                <dd className="employee-request-card__reason">{request.reason}</dd>
              </div>
              {request.requestType === 'OVERTIME' && (
                <div>
                  <dt>Durasi lembur diajukan</dt>
                  <dd>{request.requestedOvertimeMinutes ?? '—'} menit</dd>
                </div>
              )}
              {request.requestType === 'OVERTIME' && request.approvedOvertimeMinutes > 0 && (
                <div>
                  <dt>Durasi yang disetujui Admin</dt>
                  <dd>{request.approvedOvertimeMinutes} menit</dd>
                </div>
              )}
              {request.requestType === 'OVERTIME' && (
                <div className="employee-request-card__note">
                  Keputusan final lembur diberikan oleh Admin.
                </div>
              )}
              {request.requestType === 'SICK' && (
                <div>
                  <dt>Surat dokter</dt>
                  <dd>{request.hasAttachment ? 'Terlampir' : 'Belum tersedia'}</dd>
                </div>
              )}
              {request.decisionNote && (
                <div>
                  <dt>Catatan keputusan</dt>
                  <dd className="employee-request-card__reason">{request.decisionNote}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
      <nav className="employee-request-pagination" aria-label="Halaman pengajuan">
        <span aria-live="polite">
          Halaman {state.page.page} · {state.page.pageSize} per halaman
        </span>
        <div className="employee-request-pagination__actions">
          <Button
            disabled={state.page.page <= 1}
            onClick={() => onPageChange(state.page.page - 1)}
            variant="secondary"
          >
            Sebelumnya
          </Button>
          <Button
            disabled={!state.page.hasNextPage}
            onClick={() => onPageChange(state.page.page + 1)}
            variant="secondary"
          >
            Berikutnya
          </Button>
        </div>
      </nav>
    </div>
  );
}

export function RequestSubmissionFeedback({
  feedback,
}: Readonly<{ feedback: Readonly<{ tone: 'success' | 'danger'; message: string }> | null }>) {
  if (!feedback) return null;
  return (
    <Alert tone={feedback.tone}>
      <p>{feedback.message}</p>
    </Alert>
  );
}

export function EmployeeRequestForm({
  onSubmit,
}: Readonly<{ onSubmit: (input: AttendanceRequestCreateInput) => Promise<void> }>) {
  const [draft, setDraft] = useState<EmployeeRequestDraft>(emptyEmployeeRequestDraft);
  const [errors, setErrors] = useState<EmployeeRequestDraftErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Readonly<{
    tone: 'success' | 'danger';
    message: string;
  }> | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const submissionGate = useMemo(() => createRequestSubmissionGate(), []);
  const reasonId = useId();
  const reasonHintId = `${reasonId}-hint`;
  const reasonErrorId = `${reasonId}-error`;

  function updateDraft<K extends keyof EmployeeRequestDraft>(
    field: K,
    value: EmployeeRequestDraft[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFeedback(null);
  }

  function chooseRequestType(value: string) {
    if (
      !(EMPLOYEE_REQUEST_TYPE_OPTIONS as readonly { value: string }[]).some(
        (item) => item.value === value,
      )
    ) {
      return;
    }
    setDraft((current) => ({
      ...current,
      requestType: value as RequestFormType,
      requestedOvertimeMinutes: '',
      doctorNoteFile: null,
    }));
    setErrors({});
    setFeedback(null);
    setFileInputKey((key) => key + 1);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    const validationErrors = validateEmployeeRequestDraft(draft);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    await submissionGate(async () => {
      setSubmitting(true);
      try {
        const input = await toAttendanceRequestCreateInput(draft);
        await onSubmit(input);
        setDraft(emptyEmployeeRequestDraft());
        setErrors({});
        setFileInputKey((key) => key + 1);
        setFeedback({ tone: 'success', message: 'Pengajuan berhasil dikirim.' });
      } catch (error: unknown) {
        setFeedback({
          tone: 'danger',
          message:
            error instanceof EmployeeRequestFormError ? error.message : toUserErrorMessage(error),
        });
      } finally {
        setSubmitting(false);
      }
    });
  }

  return (
    <section
      className="section-block employee-requests__form-section"
      aria-labelledby="request-form-title"
    >
      <div className="section-heading">
        <div>
          <span className="section-kicker">BUAT PENGAJUAN</span>
          <h2 id="request-form-title">Ajukan izin, sakit, cuti, atau lembur</h2>
        </div>
      </div>
      <Alert tone="warning" title="Koreksi absensi — Belum tersedia">
        <p>
          Pengajuan koreksi belum tersedia di alur ini. Fitur koreksi menunggu implementasi BE-022;
          jangan kirim pengajuan ini sebagai jenis lain.
        </p>
      </Alert>
      <RequestSubmissionFeedback feedback={feedback} />
      <form className="employee-request-form" noValidate onSubmit={handleSubmit}>
        <div className="employee-request-form__field">
          <label className="ds-field__label" htmlFor="employee-request-type">
            Jenis pengajuan{' '}
            <span className="ds-field__required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            aria-describedby={errors.requestType ? 'employee-request-type-error' : undefined}
            aria-invalid={errors.requestType ? true : undefined}
            className="ds-input"
            id="employee-request-type"
            onChange={(event) => chooseRequestType(event.currentTarget.value)}
            required
            value={draft.requestType}
          >
            {EMPLOYEE_REQUEST_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {errors.requestType && (
            <span className="ds-field__error" id="employee-request-type-error" role="alert">
              {errors.requestType}
            </span>
          )}
        </div>
        <div className="employee-request-form__dates">
          <TextField
            {...(errors.startDate ? { error: errors.startDate } : {})}
            id="employee-request-start-date"
            label="Tanggal mulai"
            onChange={(event) => updateDraft('startDate', event.currentTarget.value)}
            required
            type="date"
            value={draft.startDate}
          />
          <TextField
            {...(errors.endDate ? { error: errors.endDate } : {})}
            id="employee-request-end-date"
            label="Tanggal selesai"
            {...(draft.startDate ? { min: draft.startDate } : {})}
            onChange={(event) => updateDraft('endDate', event.currentTarget.value)}
            required
            type="date"
            value={draft.endDate}
          />
        </div>
        <div className="employee-request-form__field">
          <label className="ds-field__label" htmlFor={reasonId}>
            Alasan{' '}
            <span className="ds-field__required" aria-hidden="true">
              *
            </span>
          </label>
          <textarea
            aria-describedby={`${reasonHintId}${errors.reason ? ` ${reasonErrorId}` : ''}`}
            aria-invalid={errors.reason ? true : undefined}
            className="ds-input employee-request-form__reason"
            id={reasonId}
            onChange={(event) => updateDraft('reason', event.currentTarget.value)}
            required
            rows={4}
            value={draft.reason}
          />
          <span className="ds-field__hint" id={reasonHintId}>
            Wajib diisi, maksimal 1.000 karakter. {Array.from(draft.reason.trim()).length}/1.000
          </span>
          {errors.reason && (
            <span className="ds-field__error" id={reasonErrorId} role="alert">
              {errors.reason}
            </span>
          )}
        </div>
        {draft.requestType === 'OVERTIME' && (
          <>
            <TextField
              {...(errors.requestedOvertimeMinutes
                ? { error: errors.requestedOvertimeMinutes }
                : {})}
              hint="Masukkan total menit lembur yang diajukan."
              id="employee-request-overtime-minutes"
              label="Durasi lembur (menit)"
              min={1}
              onChange={(event) =>
                updateDraft('requestedOvertimeMinutes', event.currentTarget.value)
              }
              required
              step={1}
              type="number"
              value={draft.requestedOvertimeMinutes}
            />
            <Alert tone="info" title="Keputusan lembur">
              <p>
                Pengajuan lembur dapat dikirim, tetapi keputusan final dan perhitungan lembur
                dilakukan oleh Admin.
              </p>
            </Alert>
          </>
        )}
        {draft.requestType === 'SICK' && (
          <div className="employee-request-form__field">
            <label className="ds-field__label" htmlFor="employee-request-doctor-note">
              Foto surat dokter{' '}
              <span className="ds-field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              accept="image/jpeg,image/png,image/webp"
              aria-describedby={`employee-request-doctor-note-hint${errors.doctorNoteFile ? ' employee-request-doctor-note-error' : ''}`}
              aria-invalid={errors.doctorNoteFile ? true : undefined}
              className="ds-input employee-request-form__file"
              id="employee-request-doctor-note"
              key={fileInputKey}
              onChange={(event) => {
                updateDraft('doctorNoteFile', event.currentTarget.files?.[0] ?? null);
              }}
              required
              type="file"
            />
            <span className="ds-field__hint" id="employee-request-doctor-note-hint">
              JPEG, PNG, atau WebP; ukuran maksimal {MAX_DOCTOR_NOTE_BYTES / (1024 * 1024)} MiB.
              {draft.doctorNoteFile ? ` Dipilih: ${draft.doctorNoteFile.name}.` : ''}
            </span>
            {errors.doctorNoteFile && (
              <span
                className="ds-field__error"
                id="employee-request-doctor-note-error"
                role="alert"
              >
                {errors.doctorNoteFile}
              </span>
            )}
          </div>
        )}
        <div className="employee-request-form__actions">
          <Button disabled={submitting} loading={submitting} type="submit">
            {submitting ? 'Mengirim pengajuan…' : 'Kirim pengajuan'}
          </Button>
        </div>
      </form>
    </section>
  );
}

export function EmployeeRequestsPage() {
  const [listState, setListState] = useState<RequestListState>({ status: 'loading' });
  const currentPage = useRef(1);
  const requestVersion = useRef(0);

  const loadPage = useCallback(async (page: number, signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    currentPage.current = page;
    setListState({ status: 'loading' });
    try {
      const result = await attendanceRequestsApi.listRequests(
        { page, pageSize: REQUEST_PAGE_SIZE },
        signal,
      );
      if (version === requestVersion.current) setListState({ status: 'loaded', page: result });
    } catch (error: unknown) {
      if (signal?.aborted) return;
      if (version === requestVersion.current) setListState({ status: 'error', error });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadPage(1, controller.signal);
    return () => {
      controller.abort();
      requestVersion.current += 1;
    };
  }, [loadPage]);

  async function submitRequest(input: AttendanceRequestCreateInput) {
    await attendanceRequestsApi.createRequest(input);
    await loadPage(1);
  }

  return (
    <div className="employee-requests">
      <section className="welcome-panel employee-requests__welcome">
        <div className="welcome-copy">
          <span className="section-kicker">PENGAJUAN PRIBADI</span>
          <h2>Ajukan kebutuhan kerja dengan jelas.</h2>
          <p>
            Kirim izin, sakit, cuti tahunan, atau lembur. Data pengajuan yang terlihat di bawah
            berasal dari server dan hanya untuk akun Anda.
          </p>
        </div>
        <div className="welcome-badge" aria-hidden="true">
          <span>AJ</span>
          <small>
            DATA
            <br />
            PRIBADI
          </small>
        </div>
      </section>
      <EmployeeRequestForm onSubmit={submitRequest} />
      <section className="section-block" aria-labelledby="my-requests-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">RIWAYAT PRIBADI</span>
            <h2 id="my-requests-title">Daftar pengajuan saya</h2>
          </div>
        </div>
        <EmployeeRequestList
          onPageChange={(page) => void loadPage(page)}
          onRetry={() => void loadPage(currentPage.current)}
          state={listState}
        />
      </section>
    </div>
  );
}
