import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { toUserErrorMessage } from '../api/error-message.js';
import {
  attendanceReviewApi,
  type SignedRequestAttachment,
  type ReviewerRequestDto,
  type ReviewerRequestPage,
  type ReviewerRole,
  type VerificationDecision,
} from '../api/attendance-review-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { getRequestPresentation } from '../domain/attendance-state.js';
import './review-pages.css';

const PAGE_SIZE = 25;

export type RequestReviewQueueState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; page: ReviewerRequestPage }>;

type ReviewNotice = Readonly<{ tone: 'success' | 'warning' | 'danger'; message: string }>;

export type RequestAttachmentDownloadState =
  | Readonly<{ status: 'idle' | 'loading' | 'expired' }>
  | Readonly<{ status: 'error'; message: string }>
  | Readonly<{ status: 'ready'; attachment: SignedRequestAttachment }>;

type RequestAttachmentDownloadAction =
  | Readonly<{ type: 'prepare' }>
  | Readonly<{ type: 'ready'; attachment: SignedRequestAttachment }>
  | Readonly<{ type: 'error'; message: string }>
  | Readonly<{ type: 'expired' }>
  | Readonly<{ type: 'reset' }>;

export function requestAttachmentDownloadReducer(
  state: RequestAttachmentDownloadState,
  action: RequestAttachmentDownloadAction,
): RequestAttachmentDownloadState {
  switch (action.type) {
    case 'prepare':
      return { status: 'loading' };
    case 'ready':
      return { status: 'ready', attachment: action.attachment };
    case 'error':
      return { status: 'error', message: action.message };
    case 'expired':
      return { status: 'expired' };
    case 'reset':
      return { status: 'idle' };
  }
}

export function RequestAttachmentDownload({
  state,
  onPrepare,
  onExpired,
}: Readonly<{
  state: RequestAttachmentDownloadState;
  onPrepare: () => void;
  onExpired: () => void;
}>) {
  if (state.status === 'ready') {
    return (
      <div className="review-attachment">
        <p className="review-attachment__status" role="status" aria-live="polite">
          Tautan unduh sementara siap. Surat dokter tidak ditampilkan di halaman.
        </p>
        <a
          className="review-attachment__link"
          href={state.attachment.url}
          onClick={(event) => {
            if (Date.parse(state.attachment.expiresAt) <= Date.now()) {
              event.preventDefault();
              onExpired();
            }
          }}
          referrerPolicy="no-referrer"
          rel="noreferrer noopener"
          target="_blank"
        >
          Unduh surat dokter
        </a>
        <span className="review-attachment__expiry">
          Tautan berlaku sampai {formatInstant(state.attachment.expiresAt)} WIB.
        </span>
      </div>
    );
  }

  return (
    <div className="review-attachment">
      {state.status === 'loading' ? (
        <>
          <p className="review-attachment__status" role="status" aria-live="polite">
            Meminta tautan unduh surat dokter…
          </p>
          <Button disabled loading onClick={onPrepare}>
            Menyiapkan tautan unduh…
          </Button>
        </>
      ) : state.status === 'error' ? (
        <>
          <p className="review-attachment__error" role="alert">
            {state.message}
          </p>
          <Button onClick={onPrepare} variant="secondary">
            Coba lagi
          </Button>
        </>
      ) : state.status === 'expired' ? (
        <>
          <p className="review-attachment__status" role="status" aria-live="polite">
            Tautan unduh kedaluwarsa. Siapkan tautan baru untuk melanjutkan.
          </p>
          <Button onClick={onPrepare} variant="secondary">
            Siapkan tautan baru
          </Button>
        </>
      ) : (
        <>
          <p className="review-attachment__hint">
            Surat dokter tidak ditampilkan di halaman. Tautan unduh berlaku singkat.
          </p>
          <Button onClick={onPrepare} variant="secondary">
            Siapkan tautan unduh
          </Button>
        </>
      )}
    </div>
  );
}

function requestTypeLabel(type: ReviewerRequestDto['requestType']): string {
  const labels: Record<ReviewerRequestDto['requestType'], string> = {
    LEAVE: 'Izin',
    SICK: 'Sakit',
    ANNUAL_LEAVE: 'Cuti tahunan',
    OVERTIME: 'Lembur',
  };
  return labels[type];
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

function formatInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Waktu tidak valid';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(date);
}

function canDecideRequest(role: ReviewerRole, request: ReviewerRequestDto): boolean {
  return (
    request.status === 'PENDING' && !(role === 'SUPERVISOR' && request.requestType === 'OVERTIME')
  );
}

export function RequestReviewQueue({
  state,
  selectedId,
  onSelect,
  onRetry,
  onPageChange,
}: Readonly<{
  state: RequestReviewQueueState;
  selectedId: string | null;
  onSelect: (request: ReviewerRequestDto) => void;
  onRetry: () => void;
  onPageChange: (page: number) => void;
}>) {
  if (state.status === 'loading') return <LoadingState label="Memuat pengajuan tim…" />;
  if (state.status === 'error') {
    return (
      <ErrorState error={state.error} onRetry={onRetry} title="Pengajuan belum dapat dimuat" />
    );
  }
  if (state.page.items.length === 0) {
    return (
      <EmptyState
        title="Tidak ada pengajuan menunggu"
        description="Antrean hanya meminta status PENDING. Supervisor melihat data yang diizinkan server tanpa memilih toko di browser."
      />
    );
  }

  return (
    <div className="review-queue">
      <ul className="review-queue__items" aria-label="Antrean pengajuan tim">
        {state.page.items.map((request) => {
          const status = getRequestPresentation(request.status);
          return (
            <li key={request.id}>
              <button
                aria-current={selectedId === request.id ? 'true' : undefined}
                className={`review-queue-card${selectedId === request.id ? ' review-queue-card--selected' : ''}`}
                onClick={() => onSelect(request)}
                type="button"
              >
                <span className="review-queue-card__top">
                  <span>
                    <strong>{request.employee.fullName}</strong>
                    <small>{requestTypeLabel(request.requestType)}</small>
                  </span>
                  <span className={`ds-status ds-status--${status.tone}`}>
                    <span className="ds-status__dot" aria-hidden="true" />
                    {status.label}
                  </span>
                </span>
                <span className="review-queue-card__meta">
                  {formatDate(request.startDate)}
                  {request.startDate !== request.endDate ? ` – ${formatDate(request.endDate)}` : ''}
                </span>
                <span className="review-queue-card__meta">
                  Diajukan {formatInstant(request.requestedAt)} WIB
                </span>
                {request.requestType === 'OVERTIME' && (
                  <span className="review-queue-card__meta">
                    Durasi yang diminta: {request.requestedOvertimeMinutes ?? 'Tidak tersedia'}{' '}
                    menit
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <nav className="review-pagination" aria-label="Halaman antrean pengajuan">
        <span>
          Halaman {state.page.page} · {state.page.pageSize} per halaman
        </span>
        <span className="review-pagination__actions">
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
        </span>
      </nav>
    </div>
  );
}

type RequestReviewDetailProps = Readonly<{
  request: ReviewerRequestDto | null;
  role: ReviewerRole;
  submitting: boolean;
  onDecision: (decision: VerificationDecision, decisionNote: string) => Promise<void>;
  onGetAttachmentUrl: (requestId: string, signal?: AbortSignal) => Promise<SignedRequestAttachment>;
}>;

export function RequestReviewDetail(props: RequestReviewDetailProps) {
  if (!props.request) {
    return (
      <EmptyState
        title="Pilih pengajuan untuk ditinjau"
        description="Informasi pengajuan dan tindakan yang sesuai peran akan tampil setelah Anda memilih item antrean."
      />
    );
  }

  const attachmentEligible = props.request.requestType === 'SICK' && props.request.hasAttachment;
  return (
    <RequestReviewDetailContent
      key={`${props.request.id}:${attachmentEligible}`}
      {...props}
      request={props.request}
    />
  );
}

function RequestReviewDetailContent({
  request,
  role,
  submitting,
  onDecision,
  onGetAttachmentUrl,
}: RequestReviewDetailProps & Readonly<{ request: ReviewerRequestDto }>) {
  const noteId = useId();
  const [decisionNote, setDecisionNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [attachmentState, dispatchAttachment] = useReducer(requestAttachmentDownloadReducer, {
    status: 'idle',
  });
  const attachmentRequestInFlight = useRef(false);
  const attachmentController = useRef<AbortController | null>(null);
  const attachmentEligible = request.requestType === 'SICK' && request.hasAttachment;

  useEffect(
    () => () => {
      attachmentController.current?.abort();
      attachmentController.current = null;
      attachmentRequestInFlight.current = false;
    },
    [],
  );

  useEffect(() => {
    if (attachmentState.status !== 'ready') return;
    const delay = Date.parse(attachmentState.attachment.expiresAt) - Date.now();
    if (delay <= 0) {
      dispatchAttachment({ type: 'expired' });
      return;
    }
    const timeout = window.setTimeout(() => dispatchAttachment({ type: 'expired' }), delay);
    return () => window.clearTimeout(timeout);
  }, [attachmentState]);

  const finalOvertimeNeedsAdmin = role === 'SUPERVISOR' && request.requestType === 'OVERTIME';
  const canDecide = canDecideRequest(role, request);
  const status = getRequestPresentation(request.status);

  async function submitDecision(decision: VerificationDecision) {
    const note = decisionNote.trim();
    if (note.length < 1) {
      setNoteError('Catatan keputusan wajib diisi untuk menyetujui maupun menolak.');
      return;
    }
    if (note.length > 500) {
      setNoteError('Catatan keputusan maksimal 500 karakter.');
      return;
    }
    setNoteError('');
    await onDecision(decision, note);
  }

  async function prepareAttachmentDownload() {
    if (!attachmentEligible || attachmentRequestInFlight.current) return;
    attachmentRequestInFlight.current = true;
    const controller = new AbortController();
    attachmentController.current = controller;
    dispatchAttachment({ type: 'prepare' });
    try {
      const attachment = await onGetAttachmentUrl(request.id, controller.signal);
      if (controller.signal.aborted) return;
      if (Date.parse(attachment.expiresAt) <= Date.now()) {
        dispatchAttachment({ type: 'expired' });
        return;
      }
      dispatchAttachment({ type: 'ready', attachment });
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        dispatchAttachment({ type: 'error', message: toUserErrorMessage(error) });
      }
    } finally {
      if (attachmentController.current === controller) {
        attachmentController.current = null;
        attachmentRequestInFlight.current = false;
      }
    }
  }

  return (
    <article className="review-detail" aria-labelledby="request-detail-title">
      <header className="review-detail__header">
        <div>
          <span className="section-kicker">DETAIL PENGAJUAN</span>
          <h3 id="request-detail-title">{request.employee.fullName}</h3>
          <p>{requestTypeLabel(request.requestType)}</p>
        </div>
        <span className={`ds-status ds-status--${status.tone}`}>
          <span className="ds-status__dot" aria-hidden="true" />
          {status.label}
        </span>
      </header>

      <dl className="review-facts">
        <div>
          <dt>Rentang tanggal</dt>
          <dd>
            {formatDate(request.startDate)}
            {request.startDate !== request.endDate ? ` – ${formatDate(request.endDate)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Waktu pengajuan</dt>
          <dd>{formatInstant(request.requestedAt)} WIB</dd>
        </div>
        {request.requestType === 'OVERTIME' && (
          <div>
            <dt>Durasi lembur diminta</dt>
            <dd>{request.requestedOvertimeMinutes ?? 'Tidak tersedia'} menit</dd>
          </div>
        )}
        {request.requestType === 'SICK' && (
          <div>
            <dt>Surat dokter</dt>
            <dd>
              {request.hasAttachment ? (
                <>
                  <span>Lampiran tercatat</span>
                  {attachmentEligible && (
                    <RequestAttachmentDownload
                      onExpired={() => dispatchAttachment({ type: 'expired' })}
                      onPrepare={() => void prepareAttachmentDownload()}
                      state={attachmentState}
                    />
                  )}
                </>
              ) : (
                'Tidak ada lampiran'
              )}
            </dd>
          </div>
        )}
        <div className="review-facts__wide">
          <dt>Alasan karyawan</dt>
          <dd className="review-detail__reason">{request.reason}</dd>
        </div>
        {request.decisionNote && (
          <div className="review-facts__wide">
            <dt>Catatan keputusan tersimpan</dt>
            <dd>{request.decisionNote}</dd>
          </div>
        )}
      </dl>

      {role === 'SUPERVISOR' && (
        <p className="review-detail__scope">
          Cakupan pengajuan Supervisor ditentukan dan divalidasi oleh server; browser tidak mengirim
          filter toko.
        </p>
      )}

      {finalOvertimeNeedsAdmin ? (
        <Alert tone="warning" title="Keputusan lembur oleh Admin">
          Pengajuan lembur ini dapat dilihat dalam cakupan Anda, tetapi Supervisor tidak dapat
          memberi keputusan final. Teruskan kepada Admin; menit lembur hanya dihitung setelah
          persetujuan Admin.
        </Alert>
      ) : canDecide ? (
        <section className="review-decision" aria-labelledby="request-decision-title">
          <h4 id="request-decision-title">
            Keputusan pengajuan · {role === 'ADMIN' ? 'Admin' : 'Supervisor'}
          </h4>
          <label className="ds-field" htmlFor={noteId}>
            <span className="ds-field__label">
              Catatan keputusan{' '}
              <span className="ds-field__required" aria-hidden="true">
                *
              </span>
            </span>
            <textarea
              aria-describedby={`${noteId}-hint${noteError ? ` ${noteId}-error` : ''}`}
              aria-invalid={noteError ? true : undefined}
              aria-required="true"
              className="ds-input review-decision__reason"
              id={noteId}
              maxLength={500}
              onChange={(event) => setDecisionNote(event.currentTarget.value)}
              value={decisionNote}
            />
            <span className="ds-field__hint" id={`${noteId}-hint`}>
              Catatan wajib untuk semua keputusan, maksimal 500 karakter. {decisionNote.length}/500
            </span>
            {noteError && (
              <span className="ds-field__error" id={`${noteId}-error`} role="alert">
                {noteError}
              </span>
            )}
          </label>
          <div className="review-decision__actions">
            <Button
              disabled={submitting}
              loading={submitting}
              onClick={() => void submitDecision('APPROVED')}
            >
              Setujui pengajuan
            </Button>
            <Button
              disabled={submitting}
              onClick={() => void submitDecision('REJECTED')}
              variant="danger"
            >
              Tolak pengajuan
            </Button>
          </div>
        </section>
      ) : (
        <Alert tone="info" title="Tidak ada tindakan yang tersedia">
          Pengajuan ini tidak lagi berstatus menunggu sehingga tidak dapat diputus kembali.
        </Alert>
      )}
    </article>
  );
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ATTENDANCE_REQUEST_DECISION_CONFLICT'
  );
}

export function RequestReviewPage({ role }: Readonly<{ role: ReviewerRole }>) {
  const [queueState, setQueueState] = useState<RequestReviewQueueState>({ status: 'loading' });
  const [selectedRequest, setSelectedRequest] = useState<ReviewerRequestDto | null>(null);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const requestVersion = useRef(0);
  const currentPage = useRef(1);

  const loadQueue = useCallback(async (page: number, signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    currentPage.current = page;
    setSelectedRequest(null);
    setQueueState({ status: 'loading' });
    try {
      const result = await attendanceReviewApi.listRequests({ page, pageSize: PAGE_SIZE }, signal);
      if (version !== requestVersion.current) return;
      if (result.items.length === 0 && page > 1) {
        void loadQueue(page - 1, signal);
        return;
      }
      setQueueState({ status: 'loaded', page: result });
      setSelectedRequest(result.items[0] ?? null);
    } catch (error: unknown) {
      if (signal?.aborted) return;
      if (version === requestVersion.current) setQueueState({ status: 'error', error });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadQueue(1, controller.signal);
    return () => {
      controller.abort();
      requestVersion.current += 1;
    };
  }, [loadQueue]);

  async function decide(decision: VerificationDecision, decisionNote: string) {
    if (!selectedRequest || !canDecideRequest(role, selectedRequest)) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await attendanceReviewApi.decideRequest(selectedRequest.id, { decision, decisionNote });
      setNotice({ tone: 'success', message: 'Keputusan pengajuan berhasil disimpan.' });
      await loadQueue(currentPage.current);
    } catch (error: unknown) {
      if (isConflict(error)) {
        setNotice({ tone: 'warning', message: toUserErrorMessage(error) });
        await loadQueue(currentPage.current);
      } else if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'REQUEST_REQUIRES_ADMIN'
      ) {
        setNotice({
          tone: 'warning',
          message: 'Pengajuan ini harus diputuskan oleh Admin. Antrean dimuat ulang.',
        });
        await loadQueue(currentPage.current);
      } else {
        setNotice({ tone: 'danger', message: toUserErrorMessage(error) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="review-page">
      <section className="welcome-panel review-page__welcome">
        <div className="welcome-copy">
          <span className="section-kicker">REVIEW PENGAJUAN</span>
          <h2>Periksa alasan dan catatan sebelum memberi keputusan.</h2>
          <p>
            {role === 'ADMIN'
              ? 'Admin dapat memutus pengajuan yang masih menunggu; semua perubahan dicatat server.'
              : 'Pengajuan yang terlihat dibatasi cakupan server. Lembur dapat ditinjau, tetapi keputusan final tetap oleh Admin.'}
          </p>
        </div>
        <div className="welcome-badge" aria-hidden="true">
          <span>P1</span>
          <small>
            REVIEW
            <br />
            TIM
          </small>
        </div>
      </section>

      {notice && <Alert tone={notice.tone}>{notice.message}</Alert>}

      <div className="review-layout">
        <section className="review-panel" aria-labelledby="request-queue-title">
          <div className="section-heading">
            <div>
              <span className="section-kicker">ANTREAN PENDING</span>
              <h2 id="request-queue-title">Pengajuan menunggu</h2>
            </div>
          </div>
          <RequestReviewQueue
            onPageChange={(page) => {
              setNotice(null);
              void loadQueue(page);
            }}
            onRetry={() => void loadQueue(currentPage.current)}
            onSelect={(request) => {
              setNotice(null);
              setSelectedRequest(request);
            }}
            selectedId={selectedRequest?.id ?? null}
            state={queueState}
          />
        </section>
        <section
          className="review-panel review-panel--detail"
          aria-label="Detail dan keputusan pengajuan"
        >
          {queueState.status === 'loading' ? (
            <LoadingState label="Menyiapkan detail pengajuan…" />
          ) : queueState.status === 'error' ? (
            <ErrorState
              error={queueState.error}
              title="Detail belum tersedia"
              onRetry={() => void loadQueue(currentPage.current)}
            />
          ) : (
            <RequestReviewDetail
              onDecision={decide}
              onGetAttachmentUrl={(requestId, signal) =>
                attendanceReviewApi.getRequestAttachmentUrl(requestId, signal)
              }
              request={selectedRequest}
              role={role}
              submitting={submitting}
            />
          )}
        </section>
      </div>
    </div>
  );
}
