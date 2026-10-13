import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toUserErrorMessage } from '../api/error-message.js';
import {
  attendanceReviewApi,
  AttendanceReviewApiError,
  type AttendanceVerificationDto,
  type AttendanceVerificationPage,
  type ReviewerRole,
  type VerificationDecision,
} from '../api/attendance-review-api.js';
import { Alert } from '../components/ui/Alert.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import './review-pages.css';

const PAGE_SIZE = 25;

export type VerificationQueueState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; page: AttendanceVerificationPage }>;

type VerificationDetailState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; item: AttendanceVerificationDto }>;

type ReviewNotice = Readonly<{ tone: 'success' | 'warning' | 'danger'; message: string }>;

export function selfieAfterReadFailure(
  item: AttendanceVerificationDto,
  error: unknown,
): AttendanceVerificationDto {
  const confirmedMissing =
    error instanceof AttendanceReviewApiError &&
    error.status === 404 &&
    error.code === 'SELFIE_NOT_FOUND';
  return confirmedMissing ? { ...item, selfie: null } : item;
}

function attendanceTypeLabel(type: AttendanceVerificationDto['type']): string {
  return type === 'CHECK_IN' ? 'Absen masuk' : 'Absen pulang';
}

function validationStatusLabel(status: string): string {
  switch (status) {
    case 'VALID':
      return 'Valid';
    case 'PENDING_VERIFICATION':
      return 'Perlu verifikasi';
    case 'APPROVED':
      return 'Disetujui';
    case 'REJECTED':
      return 'Ditolak';
    case 'PENDING_OFFLINE':
      return 'Absen tertunda';
    default:
      return status;
  }
}

function methodLabel(method: AttendanceVerificationDto['method']): string {
  const labels: Record<AttendanceVerificationDto['method'], string> = {
    GPS: 'GPS',
    QR: 'QR toko',
    WIFI: 'Wi-Fi toko',
    SUPERVISOR: 'Konfirmasi supervisor',
    OFFLINE: 'Sinkronisasi offline',
    ASSISTED: 'Absen dibantu',
  };
  return labels[method];
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

function formatInstant(value: string | null): string {
  if (!value) return 'Tidak tercatat';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Waktu tidak valid';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(date);
}

function formatMeters(value: number | null): string {
  if (value === null) return 'Tidak tersedia';
  return `${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(value)} m`;
}

function isPastExpiry(expiresAt: string): boolean {
  return Date.parse(expiresAt) <= Date.now();
}

export function VerificationQueue({
  state,
  selectedId,
  onSelect,
  onRetry,
  onPageChange,
}: Readonly<{
  state: VerificationQueueState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onPageChange: (page: number) => void;
}>) {
  if (state.status === 'loading') return <LoadingState label="Memuat antrean verifikasi…" />;
  if (state.status === 'error') {
    return <ErrorState error={state.error} onRetry={onRetry} title="Antrean belum dapat dimuat" />;
  }
  if (state.page.items.length === 0) {
    return (
      <EmptyState
        title="Tidak ada absensi menunggu"
        description="Antrean hanya memuat absensi yang masih perlu keputusan. Cakupan toko Supervisor ditentukan dan dibatasi oleh server."
      />
    );
  }

  return (
    <div className="review-queue">
      <ul className="review-queue__items" aria-label="Antrean verifikasi absensi">
        {state.page.items.map((item) => (
          <li key={item.attendanceId}>
            <button
              aria-current={selectedId === item.attendanceId ? 'true' : undefined}
              className={`review-queue-card${selectedId === item.attendanceId ? ' review-queue-card--selected' : ''}`}
              onClick={() => onSelect(item.attendanceId)}
              type="button"
            >
              <span className="review-queue-card__top">
                <span>
                  <strong>{item.employee.fullName}</strong>
                  <small>{attendanceTypeLabel(item.type)}</small>
                </span>
                <span className="review-queue-card__status">Perlu verifikasi</span>
              </span>
              <span className="review-queue-card__meta">
                {item.store?.name ?? 'Toko tidak tercatat'} · {formatInstant(item.serverTime)} WIB
              </span>
              <span className="review-queue-card__meta">
                {item.overdue
                  ? 'Melewati SLA 24 jam'
                  : `Batas review ${formatInstant(item.dueAt)} WIB`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <nav className="review-pagination" aria-label="Halaman antrean verifikasi">
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

function SelfieEvidence({
  item,
  onRefresh,
}: Readonly<{ item: AttendanceVerificationDto; onRefresh: () => Promise<void> }>) {
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selfie = item.selfie;
  const [expired, setExpired] = useState(() => !selfie || isPastExpiry(selfie.expiresAt));

  useEffect(() => {
    setFailed(false);
    if (!selfie) {
      setExpired(true);
      return;
    }
    const remaining = Date.parse(selfie.expiresAt) - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timeout = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [item.attendanceId, selfie?.url, selfie?.expiresAt]);

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
      setFailed(false);
    } catch {
      // Retain the expired/failed state after a transient failure so the reviewer can retry.
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }

  if (!selfie) {
    return (
      <div className="review-selfie review-selfie--empty">
        <p>Foto selfie tidak tersedia atau sudah melewati masa retensi.</p>
      </div>
    );
  }

  if (expired || failed) {
    return (
      <div className="review-selfie review-selfie--empty">
        <p>Tautan foto kedaluwarsa atau tidak dapat dibuka. Minta tautan sementara yang baru.</p>
        <Button
          disabled={refreshing}
          loading={refreshing}
          onClick={() => void refresh()}
          variant="secondary"
        >
          Muat ulang foto
        </Button>
      </div>
    );
  }

  return (
    <figure className="review-selfie">
      <img
        alt={`Selfie bukti ${attendanceTypeLabel(item.type)} milik ${item.employee.fullName}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        src={selfie.url}
        onError={() => setFailed(true)}
      />
      <figcaption>
        Tautan foto sementara berlaku sampai {formatInstant(selfie.expiresAt)} WIB. Foto tidak
        disimpan oleh aplikasi.
      </figcaption>
    </figure>
  );
}

export function VerificationDetail({
  state,
  role,
  submitting,
  onRetry,
  onRefreshSelfie,
  onDecision,
}: Readonly<{
  state: VerificationDetailState;
  role: ReviewerRole;
  submitting: boolean;
  onRetry: () => void;
  onRefreshSelfie: () => Promise<void>;
  onDecision: (decision: VerificationDecision, reason?: string) => Promise<void>;
}>) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');

  useEffect(() => {
    setReason('');
    setReasonError('');
  }, [state.status === 'loaded' ? state.item.attendanceId : state.status]);

  if (state.status === 'idle') {
    return (
      <EmptyState
        title="Pilih absensi untuk ditinjau"
        description="Detail, bukti, koordinat, dan riwayat absensi akan tampil setelah Anda memilih satu item antrean."
      />
    );
  }
  if (state.status === 'loading') return <LoadingState label="Memuat detail absensi…" />;
  if (state.status === 'error') {
    return (
      <ErrorState error={state.error} onRetry={onRetry} title="Detail absensi belum tersedia" />
    );
  }

  const item = state.item;
  const canDecide = item.validationStatus === 'PENDING_VERIFICATION';
  const location = item.location;

  async function reject() {
    const cleanReason = reason.trim();
    if (cleanReason.length === 0) {
      setReasonError('Alasan wajib diisi untuk menolak absensi.');
      return;
    }
    if (cleanReason.length > 500) {
      setReasonError('Alasan maksimal 500 karakter.');
      return;
    }
    setReasonError('');
    await onDecision('REJECTED', cleanReason);
  }

  return (
    <article className="review-detail" aria-labelledby="verification-detail-title">
      <header className="review-detail__header">
        <div>
          <span className="section-kicker">DETAIL VERIFIKASI</span>
          <h3 id="verification-detail-title">{item.employee.fullName}</h3>
          <p>
            {attendanceTypeLabel(item.type)} · {item.store?.name ?? 'Toko tidak tercatat'}
          </p>
        </div>
        <span
          className={`ds-status ${item.overdue ? 'ds-status--negative' : 'ds-status--warning'}`}
        >
          <span className="ds-status__dot" aria-hidden="true" />
          {item.overdue ? 'Melewati SLA' : 'Menunggu review'}
        </span>
      </header>

      {role === 'SUPERVISOR' && (
        <p className="review-detail__scope">
          Cakupan Supervisor divalidasi server; data ini berasal dari antrean yang diizinkan.
        </p>
      )}

      <section className="review-detail__section" aria-labelledby="verification-evidence-title">
        <h4 id="verification-evidence-title">Bukti selfie</h4>
        <SelfieEvidence item={item} onRefresh={onRefreshSelfie} />
      </section>

      <section className="review-detail__section" aria-labelledby="verification-facts-title">
        <h4 id="verification-facts-title">Waktu dan validasi</h4>
        <dl className="review-facts">
          <div>
            <dt>Tanggal kerja</dt>
            <dd>{formatDate(item.workDate)}</dd>
          </div>
          <div>
            <dt>Waktu server asli</dt>
            <dd>{formatInstant(item.serverTime)} WIB</dd>
          </div>
          <div>
            <dt>Waktu perangkat</dt>
            <dd>{formatInstant(item.deviceTime)} WIB</dd>
          </div>
          <div>
            <dt>Batas SLA (24 jam)</dt>
            <dd>{formatInstant(item.dueAt)} WIB</dd>
          </div>
          <div>
            <dt>Status saat ditinjau</dt>
            <dd>{validationStatusLabel(item.validationStatus)}</dd>
          </div>
          <div>
            <dt>Metode validasi</dt>
            <dd>{methodLabel(item.method)}</dd>
          </div>
          <div>
            <dt>Jaringan</dt>
            <dd>{item.networkStatus === 'ONLINE' ? 'Online' : 'Offline'}</dd>
          </div>
          <div>
            <dt>Perangkat</dt>
            <dd>{item.device.name ?? 'Nama perangkat tidak tersedia'}</dd>
          </div>
          {item.employee.position && (
            <div>
              <dt>Jabatan</dt>
              <dd>{item.employee.position}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="review-detail__section" aria-labelledby="verification-location-title">
        <h4 id="verification-location-title">Lokasi absensi</h4>
        {location ? (
          <dl className="review-facts">
            <div>
              <dt>Koordinat lintang</dt>
              <dd>{location.latitude.toFixed(6)}</dd>
            </div>
            <div>
              <dt>Koordinat bujur</dt>
              <dd>{location.longitude.toFixed(6)}</dd>
            </div>
            <div>
              <dt>Akurasi GPS</dt>
              <dd>{formatMeters(location.accuracyMeters)}</dd>
            </div>
            <div>
              <dt>Jarak ke lokasi validasi</dt>
              <dd>{formatMeters(location.distanceMeters)}</dd>
            </div>
          </dl>
        ) : (
          <p className="review-detail__scope">Koordinat tidak tercatat pada bukti absensi ini.</p>
        )}
        <Alert tone="info" title="Peta belum tersedia">
          Belum ada provider peta atau kebijakan pemrosesan koordinat yang dipilih. Koordinat tidak
          dikirim ke layanan pihak ketiga.
        </Alert>
      </section>

      <section className="review-detail__section" aria-labelledby="verification-history-title">
        <h4 id="verification-history-title">Riwayat absensi terkait</h4>
        {item.recentAttendance.length === 0 ? (
          <p className="review-detail__scope">
            Belum ada riwayat absensi sebelumnya yang tersedia.
          </p>
        ) : (
          <div
            className="review-history"
            role="region"
            aria-label="Riwayat absensi terkait"
            tabIndex={0}
          >
            <table>
              <caption className="review-visually-hidden">Riwayat absensi karyawan terkait</caption>
              <thead>
                <tr>
                  <th scope="col">Jenis</th>
                  <th scope="col">Tanggal kerja</th>
                  <th scope="col">Waktu server</th>
                  <th scope="col">Status</th>
                  <th scope="col">Catatan</th>
                </tr>
              </thead>
              <tbody>
                {item.recentAttendance.map((history) => (
                  <tr key={history.attendanceId}>
                    <td>{attendanceTypeLabel(history.type)}</td>
                    <td>{formatDate(history.workDate)}</td>
                    <td>{formatInstant(history.serverTime)} WIB</td>
                    <td>{validationStatusLabel(history.validationStatus)}</td>
                    <td>{history.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canDecide ? (
        <section className="review-decision" aria-labelledby="verification-decision-title">
          <h4 id="verification-decision-title">
            Keputusan review · {role === 'ADMIN' ? 'Admin' : 'Supervisor'}
          </h4>
          <label className="ds-field" htmlFor={reasonId}>
            <span className="ds-field__label">Alasan penolakan (wajib jika menolak)</span>
            <textarea
              aria-describedby={`${reasonId}-hint${reasonError ? ` ${reasonId}-error` : ''}`}
              aria-invalid={reasonError ? true : undefined}
              aria-required="true"
              className="ds-input review-decision__reason"
              id={reasonId}
              maxLength={500}
              onChange={(event) => setReason(event.currentTarget.value)}
              value={reason}
            />
            <span className="ds-field__hint" id={`${reasonId}-hint`}>
              Maksimal 500 karakter. {reason.length}/500
            </span>
            {reasonError && (
              <span className="ds-field__error" id={`${reasonId}-error`} role="alert">
                {reasonError}
              </span>
            )}
          </label>
          <div className="review-decision__actions">
            <Button
              disabled={submitting}
              loading={submitting}
              onClick={() => void onDecision('APPROVED')}
            >
              Setujui absensi
            </Button>
            <Button disabled={submitting} onClick={() => void reject()} variant="danger">
              Tolak absensi
            </Button>
          </div>
        </section>
      ) : (
        <Alert tone="warning" title="Status sudah berubah">
          Data ini tidak lagi menunggu verifikasi sehingga keputusan baru tidak dapat dikirim.
        </Alert>
      )}
    </article>
  );
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'ATTENDANCE_VERIFICATION_CONFLICT'
  );
}

export function VerificationReviewPage({ role }: Readonly<{ role: ReviewerRole }>) {
  const [queueState, setQueueState] = useState<VerificationQueueState>({ status: 'loading' });
  const [detailState, setDetailState] = useState<VerificationDetailState>({ status: 'idle' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const queueVersion = useRef(0);
  const detailVersion = useRef(0);
  const currentPage = useRef(1);

  const loadDetail = useCallback(async (attendanceId: string, signal?: AbortSignal) => {
    const version = ++detailVersion.current;
    setSelectedId(attendanceId);
    setDetailState({ status: 'loading' });
    try {
      const item = await attendanceReviewApi.getVerificationDetail(attendanceId, signal);
      if (version === detailVersion.current) setDetailState({ status: 'loaded', item });
    } catch (error: unknown) {
      if (signal?.aborted) return;
      if (version === detailVersion.current) setDetailState({ status: 'error', error });
    }
  }, []);

  const loadQueue = useCallback(
    async (page: number, signal?: AbortSignal) => {
      const version = ++queueVersion.current;
      currentPage.current = page;
      detailVersion.current += 1;
      setSelectedId(null);
      setDetailState({ status: 'idle' });
      setQueueState({ status: 'loading' });
      try {
        const result = await attendanceReviewApi.listVerifications(
          { page, pageSize: PAGE_SIZE },
          signal,
        );
        if (version !== queueVersion.current) return;
        if (result.items.length === 0 && page > 1) {
          void loadQueue(page - 1, signal);
          return;
        }
        setQueueState({ status: 'loaded', page: result });
        const first = result.items[0];
        if (first) void loadDetail(first.attendanceId, signal);
      } catch (error: unknown) {
        if (signal?.aborted) return;
        if (version === queueVersion.current) setQueueState({ status: 'error', error });
      }
    },
    [loadDetail],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadQueue(1, controller.signal);
    return () => {
      controller.abort();
      queueVersion.current += 1;
      detailVersion.current += 1;
    };
  }, [loadQueue]);

  async function refreshSelfie() {
    const current = detailState;
    if (current.status !== 'loaded') return;
    const attendanceId = current.item.attendanceId;
    try {
      const selfie = await attendanceReviewApi.getVerificationSelfieUrl(attendanceId);
      setDetailState((state) =>
        state.status === 'loaded' && state.item.attendanceId === attendanceId
          ? { status: 'loaded', item: { ...state.item, selfie } }
          : state,
      );
    } catch (error: unknown) {
      const nextItem = selfieAfterReadFailure(current.item, error);
      const notFound = nextItem !== current.item;
      if (notFound) {
        setDetailState((state) =>
          state.status === 'loaded' && state.item.attendanceId === attendanceId
            ? { status: 'loaded', item: nextItem }
            : state,
        );
      }
      setNotice({
        tone: notFound ? 'warning' : 'danger',
        message: toUserErrorMessage(error),
      });
      if (!notFound) throw error;
    }
  }

  async function decide(decision: VerificationDecision, reason?: string) {
    const current = detailState;
    if (current.status !== 'loaded' || current.item.validationStatus !== 'PENDING_VERIFICATION')
      return;
    setSubmitting(true);
    setNotice(null);
    try {
      await attendanceReviewApi.decideVerification(current.item.attendanceId, {
        decision,
        ...(reason === undefined ? {} : { reason }),
      });
      setNotice({
        tone: 'success',
        message:
          decision === 'APPROVED' ? 'Absensi berhasil disetujui.' : 'Absensi berhasil ditolak.',
      });
      await loadQueue(currentPage.current);
    } catch (error: unknown) {
      if (isConflict(error)) {
        setNotice({ tone: 'warning', message: toUserErrorMessage(error) });
        await loadQueue(currentPage.current);
      } else {
        setNotice({ tone: 'danger', message: toUserErrorMessage(error) });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function chooseAttendance(attendanceId: string) {
    setNotice(null);
    void loadDetail(attendanceId);
  }

  return (
    <div className="review-page">
      <section className="welcome-panel review-page__welcome">
        <div className="welcome-copy">
          <span className="section-kicker">REVIEW ABSENSI</span>
          <h2>Periksa bukti sebelum menetapkan status kehadiran.</h2>
          <p>
            {role === 'ADMIN'
              ? 'Antrean menampilkan absensi yang menunggu keputusan dan bukti sesuai akses Admin.'
              : 'Antrean dan detail dibatasi pada toko yang ditugaskan oleh Admin; server menjadi sumber cakupan.'}
          </p>
        </div>
        <div className="welcome-badge" aria-hidden="true">
          <span>24</span>
          <small>
            JAM
            <br />
            SLA
          </small>
        </div>
      </section>

      {notice && <Alert tone={notice.tone}>{notice.message}</Alert>}

      <div className="review-layout">
        <section className="review-panel" aria-labelledby="verification-queue-title">
          <div className="section-heading">
            <div>
              <span className="section-kicker">ANTREAN</span>
              <h2 id="verification-queue-title">Menunggu verifikasi</h2>
            </div>
          </div>
          <VerificationQueue
            onPageChange={(page) => {
              setNotice(null);
              void loadQueue(page);
            }}
            onRetry={() => void loadQueue(currentPage.current)}
            onSelect={chooseAttendance}
            selectedId={selectedId}
            state={queueState}
          />
        </section>
        <section
          className="review-panel review-panel--detail"
          aria-label="Detail dan keputusan absensi"
        >
          <VerificationDetail
            onDecision={decide}
            onRefreshSelfie={refreshSelfie}
            onRetry={() => {
              if (selectedId) void loadDetail(selectedId);
            }}
            role={role}
            state={detailState}
            submitting={submitting}
          />
        </section>
      </div>
    </div>
  );
}
