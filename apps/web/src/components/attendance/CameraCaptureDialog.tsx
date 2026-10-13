import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { toUserErrorMessage } from '../../api/error-message.js';
import { serializeApiDateTime } from '../../api/api-contract.js';
import {
  AttendanceSubmissionError,
  canRetryAttendanceRequest,
  prepareAttendanceAttempt,
  submitAttendanceAttempt,
  type AttendanceApiOptions,
  type AttendanceAttemptDraft,
  type AttendanceReceipt,
  type AttendanceType,
} from '../../api/attendance-api.js';
import { AttendanceReceiptNotice } from './AttendanceReceiptNotice.js';
import { OfflineAttendanceQueue, OfflineQueueError } from './offline-attendance-queue.js';
import { CameraCaptureController, type CameraCaptureSnapshot } from './camera-capture.js';
import { type LivenessInstruction, type LivenessSnapshot } from './liveness.js';
import { useLocationCapture } from './use-location-capture.js';
import { LocationCaptureNotice } from './LocationCaptureNotice.js';
import { AttendanceSubmitGate } from './attendance-submit-gate.js';
import {
  resolveAttendanceSubmissionPlan,
  shouldOfferFreshCapture,
} from './attendance-submission-model.js';
import './camera-capture.css';

type CameraCaptureDialogProps = Readonly<{
  onClose: () => void;
  attendanceType?: AttendanceType;
  onSubmitted?: (receipt: AttendanceReceipt) => void;
  employeeId?: string | null;
  offlineQueue?: OfflineAttendanceQueue | null;
  onQueued?: (queueId: string) => void;
  onConflict?: () => void;
}>;

function formatKiB(sizeBytes: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(sizeBytes / 1024);
}

const INSTRUCTION_LABELS: Record<LivenessInstruction, string> = {
  blink: 'Berkedip satu kali',
  'turn-left': 'Tolehkan kepala ke kiri',
  'turn-right': 'Tolehkan kepala ke kanan',
};

export function LivenessStatusNotice({ snapshot }: Readonly<{ snapshot: LivenessSnapshot }>) {
  if (snapshot.status === 'idle') return null;

  const isAlert = ['failed', 'timeout', 'permission-denied'].includes(snapshot.status);

  return (
    <section
      aria-label="Pemeriksaan liveness"
      className={`camera-dialog__liveness camera-dialog__liveness--${snapshot.status}`}
    >
      <span className="section-kicker">PEMERIKSAAN WAJAH</span>
      <h3>Instruksi acak</h3>
      {snapshot.instruction && <strong>{INSTRUCTION_LABELS[snapshot.instruction]}</strong>}
      <p role={isAlert ? 'alert' : 'status'} aria-live={isAlert ? 'assertive' : 'polite'}>
        {snapshot.message}
      </p>
    </section>
  );
}

export function CameraCaptureDialog({
  onClose,
  attendanceType = 'CHECK_IN',
  onSubmitted = () => undefined,
  employeeId,
  offlineQueue,
  onQueued = () => undefined,
  onConflict,
}: CameraCaptureDialogProps) {
  const [controller] = useState(() => new CameraCaptureController());
  const [snapshot, setSnapshot] = useState<CameraCaptureSnapshot>(controller.getSnapshot);
  const [videoReady, setVideoReady] = useState(false);
  const {
    snapshot: locationSnapshot,
    captureLocation,
    cancelCapture,
    resetCapture,
  } = useLocationCapture();
  const [submissionState, setSubmissionState] = useState<
    'idle' | 'preparing' | 'uploading' | 'sending' | 'error' | 'complete'
  >('idle');
  const [submissionError, setSubmissionError] = useState('');
  const [retryAllowed, setRetryAllowed] = useState(false);
  const [conflictRecoveryRequired, setConflictRecoveryRequired] = useState(false);
  const [requiresFreshCapture, setRequiresFreshCapture] = useState(false);
  const [receipt, setReceipt] = useState<AttendanceReceipt | null>(null);
  const [localQueueId, setLocalQueueId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const enableCameraRef = useRef<HTMLButtonElement>(null);
  const aliveRef = useRef(false);
  const attemptDraftRef = useRef<AttendanceAttemptDraft | null>(null);
  const submitGateRef = useRef(new AttendanceSubmitGate());
  const requestAbortRef = useRef<AbortController | null>(null);
  const capturedAtRef = useRef<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const restoreFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    aliveRef.current = true;
    controller.activate();
    const unsubscribe = controller.subscribe(setSnapshot);

    if (dialog) {
      try {
        if (!dialog.open) dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    }
    enableCameraRef.current?.focus();
    void controller.start();
    captureLocation();

    return () => {
      aliveRef.current = false;
      requestAbortRef.current?.abort();
      cancelCapture();
      unsubscribe();
      controller.dispose();
      if (dialog?.open) {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute('open');
        }
      }
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    };
  }, [cancelCapture, captureLocation, controller]);

  useEffect(() => {
    const video = videoRef.current;
    if (snapshot.status !== 'ready' || !video) {
      setVideoReady(false);
      if (video) video.srcObject = null;
      return;
    }

    video.srcObject = controller.getStream();
    void video.play().catch(() => controller.reportPreviewError());
    return () => {
      video.srcObject = null;
    };
  }, [controller, snapshot.status]);

  useEffect(() => {
    const video = videoRef.current;
    const activeStatuses = ['in-progress', 'face-missing'];
    if (!videoReady || snapshot.status !== 'ready' || !video) return;
    if (!activeStatuses.includes(controller.getSnapshot().liveness.status)) return;

    let cancelled = false;
    let animationFrame = 0;

    const inspectFrame = async () => {
      if (cancelled) return;
      await controller.observeLivenessFrame(video);
      if (cancelled) return;
      if (activeStatuses.includes(controller.getSnapshot().liveness.status)) {
        animationFrame = window.requestAnimationFrame(() => void inspectFrame());
      }
    };

    animationFrame = window.requestAnimationFrame(() => void inspectFrame());
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [controller, snapshot.status, videoReady]);

  function closeDialog() {
    requestAbortRef.current?.abort();
    cancelCapture();
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    onClose();
  }

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeDialog();
  }

  async function handleCapture() {
    const video = videoRef.current;
    if (!video) return;
    const captureTime = serializeApiDateTime(new Date());
    const photo = await controller.capture(video);
    if (photo) capturedAtRef.current = captureTime;
  }

  function retryLocation() {
    resetCapture();
    captureLocation();
  }

  async function submitAttendance() {
    const plan = resolveAttendanceSubmissionPlan(
      attemptDraftRef.current,
      locationSnapshot.location,
    );

    await submitGateRef.current.run(async () => {
      if (plan.kind === 'blocked') return null;
      const abortController = new AbortController();
      requestAbortRef.current = abortController;
      const options: AttendanceApiOptions = {
        signal: abortController.signal,
        onProgress: (stage) => {
          if (!aliveRef.current) return;
          if (stage === 'creating-intent') setSubmissionState('preparing');
          if (stage === 'uploading-selfie') setSubmissionState('uploading');
          if (stage === 'sending-attempt') setSubmissionState('sending');
        },
      };

      setSubmissionError('');
      setRetryAllowed(false);
      setConflictRecoveryRequired(false);
      setSubmissionState('preparing');
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          if (plan.kind === 'replay') {
            throw new AttendanceSubmissionError(0, 'NETWORK_ERROR', 'attempt');
          }
          const currentPhoto = controller.getSnapshot().photo;
          if (!employeeId) throw new OfflineQueueError('OWNER_REQUIRED');
          if (!offlineQueue) throw new OfflineQueueError('UNAVAILABLE');
          if (!currentPhoto || plan.kind !== 'new' || !capturedAtRef.current) {
            throw new OfflineQueueError('INVALID_CAPTURE');
          }
          const queueId = await offlineQueue.enqueue(employeeId, {
            type: attendanceType,
            clientRecordedAt: capturedAtRef.current,
            photo: currentPhoto.blob,
            location: plan.location,
          });
          if (!aliveRef.current) return null;
          capturedAtRef.current = null;
          controller.clearCapturedPhoto();
          setLocalQueueId(queueId);
          setSubmissionState('complete');
          setSubmissionError('');
          setRetryAllowed(false);
          onQueued(queueId);
          return null;
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw new AttendanceSubmissionError(
            0,
            'NETWORK_ERROR',
            attemptDraftRef.current ? 'attempt' : 'intent',
          );
        }

        let draft = plan.kind === 'replay' ? plan.draft : null;
        if (!draft) {
          const currentPhoto = controller.getSnapshot().photo;
          if (!currentPhoto || plan.kind !== 'new' || !capturedAtRef.current) return null;
          const livenessPassed =
            snapshot.liveness.status === 'passed' && snapshot.liveness.faceDetected;
          draft = await prepareAttendanceAttempt(
            {
              type: attendanceType,
              clientRecordedAt: capturedAtRef.current,
              photo: currentPhoto.blob,
              location: plan.location,
              liveness: {
                faceDetected: livenessPassed,
                passed: livenessPassed,
              },
            },
            options,
          );
          attemptDraftRef.current = draft;
          setRequiresFreshCapture(true);
          if (!aliveRef.current) return null;
          controller.clearCapturedPhoto();
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw new AttendanceSubmissionError(0, 'NETWORK_ERROR', 'attempt');
        }

        const serverReceipt = await submitAttendanceAttempt(draft, options);
        if (!aliveRef.current) return serverReceipt;
        attemptDraftRef.current = null;
        setRequiresFreshCapture(false);
        setReceipt(serverReceipt);
        setSubmissionState('complete');
        setSubmissionError('');
        setRetryAllowed(false);
        controller.clearCapturedPhoto();
        onSubmitted(serverReceipt);
        return serverReceipt;
      } catch (error) {
        if (!aliveRef.current || abortController.signal.aborted) return null;
        const retryable = canRetryAttendanceRequest(error);
        setConflictRecoveryRequired(
          error instanceof AttendanceSubmissionError && error.status === 409,
        );
        if (!retryable) attemptDraftRef.current = null;
        const queueMessages: Partial<Record<OfflineQueueError['code'], string>> = {
          QUOTA: 'Penyimpanan perangkat penuh. Absensi belum masuk antrean offline.',
          ENCRYPTION_UNAVAILABLE:
            'Penyimpanan terenkripsi tidak didukung. Absensi belum masuk antrean offline.',
          CORRUPT: 'Antrean terenkripsi tidak dapat dibuka. Data lokal dipertahankan.',
          OWNER_REQUIRED: 'Sesi karyawan tidak dapat dipastikan. Absensi belum masuk antrean.',
          ACK_INVALID: 'Receipt server belum dapat diverifikasi. Bukti lokal tetap dipertahankan.',
          INVALID_CAPTURE: 'Foto atau GPS belum lengkap. Absensi belum masuk antrean.',
          UNAVAILABLE: 'Penyimpanan aman tidak tersedia. Absensi belum masuk antrean offline.',
        };
        setSubmissionError(
          error instanceof OfflineQueueError
            ? (queueMessages[error.code] ?? 'Antrean offline belum dapat disimpan.')
            : toUserErrorMessage(error),
        );
        setRetryAllowed(retryable);
        setSubmissionState('error');
        return null;
      } finally {
        if (requestAbortRef.current === abortController) requestAbortRef.current = null;
      }
    });
  }

  function retakePhoto() {
    if (attemptDraftRef.current) return;
    capturedAtRef.current = null;
    setRequiresFreshCapture(false);
    setSubmissionState('idle');
    setSubmissionError('');
    setRetryAllowed(false);
    setVideoReady(false);
    resetCapture();
    captureLocation();
    void controller.retake();
  }

  const hasError =
    snapshot.status === 'denied' ||
    snapshot.status === 'not-supported' ||
    snapshot.status === 'error';
  const actionLabel = attendanceType === 'CHECK_IN' ? 'masuk' : 'pulang';
  const locationCanRetry = ['denied', 'timeout', 'unavailable', 'invalid', 'error'].includes(
    locationSnapshot.status,
  );
  const hasPhotoOrDraft = Boolean(snapshot.photo || attemptDraftRef.current);
  const busy = ['preparing', 'uploading', 'sending'].includes(submissionState);
  const canSubmit =
    !receipt &&
    !localQueueId &&
    hasPhotoOrDraft &&
    (Boolean(attemptDraftRef.current) || locationSnapshot.status === 'captured') &&
    (submissionState === 'idle' || submissionState === 'error');
  const canRetake = shouldOfferFreshCapture({
    hasReceipt: Boolean(receipt || localQueueId),
    hasDraft: Boolean(attemptDraftRef.current),
    hasPhoto: snapshot.photo !== null,
    requiresFreshCapture,
    busy,
  });

  return (
    <dialog
      aria-describedby="camera-dialog-description"
      aria-labelledby="camera-dialog-title"
      className="camera-dialog"
      onCancel={handleCancel}
      ref={dialogRef}
    >
      <header className="camera-dialog__header">
        <div>
          <span className="section-kicker">ABSENSI KARYAWAN</span>
          <h2 id="camera-dialog-title">Absen {actionLabel}</h2>
        </div>
        <button
          aria-label="Tutup kamera"
          className="camera-dialog__close"
          onClick={closeDialog}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <p className="camera-dialog__intro" id="camera-dialog-description">
        Kamera depan dan satu pengambilan GPS dimulai untuk percobaan ini. Foto hanya berasal dari
        stream kamera; tidak ada pilihan galeri.
      </p>

      {snapshot.status === 'ready' && (
        <div className="camera-dialog__preview" aria-label="Pratinjau langsung kamera depan">
          <video
            aria-label="Pratinjau langsung kamera depan"
            autoPlay
            muted
            onCanPlay={() => setVideoReady(true)}
            onLoadedMetadata={() => setVideoReady(true)}
            playsInline
            ref={videoRef}
          />
        </div>
      )}

      {snapshot.status === 'captured' && snapshot.photo && (
        <figure className="camera-dialog__photo">
          <img
            alt="Foto selfie sementara yang hanya tersimpan di memori halaman ini"
            src={snapshot.photo.objectUrl}
          />
          <figcaption>
            Ukuran foto: <strong>{formatKiB(snapshot.photo.sizeBytes)} KiB</strong> dari batas 200
            KiB.
          </figcaption>
        </figure>
      )}

      {snapshot.status === 'idle' && (
        <p className="camera-dialog__status" role="status">
          Saat siap, aktifkan kamera dan pilih Izinkan pada dialog browser.
        </p>
      )}
      {(snapshot.status === 'requesting' || snapshot.status === 'capturing') && (
        <p className="camera-dialog__status" role="status" aria-live="polite">
          {snapshot.message}
        </p>
      )}
      {hasError && (
        <div className="camera-dialog__error" role="alert">
          <strong>
            {snapshot.status === 'denied'
              ? 'Izin kamera diperlukan'
              : snapshot.status === 'not-supported'
                ? 'Kamera tidak tersedia'
                : snapshot.liveness.status === 'timeout'
                  ? 'Waktu pemeriksaan habis'
                  : snapshot.liveness.status === 'failed'
                    ? 'Pemeriksaan belum berhasil'
                    : 'Kamera belum siap'}
          </strong>
          <p>{snapshot.message}</p>
        </div>
      )}
      <LivenessStatusNotice snapshot={snapshot.liveness} />
      {!receipt && <LocationCaptureNotice snapshot={locationSnapshot} />}
      {locationCanRetry && !receipt && (
        <button
          className="secondary-action-button camera-dialog__action"
          onClick={retryLocation}
          type="button"
        >
          Coba lagi lokasi
        </button>
      )}
      {receipt && <AttendanceReceiptNotice receipt={receipt} />}
      {localQueueId && (
        <section className="camera-dialog__error" role="status" aria-live="polite">
          <strong>Belum tersinkron — tersimpan terenkripsi di perangkat</strong>
          <p>
            Belum ada receipt atau status server. ID antrean lokal (bukan kode bukti server):{' '}
            {localQueueId}
          </p>
        </section>
      )}
      {submissionError && (
        <div className="camera-dialog__error" role="alert">
          <strong>Absensi belum terkonfirmasi</strong>
          <p>{submissionError}</p>
          {requiresFreshCapture && !attemptDraftRef.current && (
            <p>
              Foto sebelumnya sudah dilepas setelah diunggah. Ambil foto baru untuk percobaan
              berikutnya.
            </p>
          )}
          {attemptDraftRef.current && retryAllowed && (
            <p>
              Pengiriman ulang akan memakai kunci dan payload yang sama agar tidak membuat duplikat.
            </p>
          )}
          {conflictRecoveryRequired && onConflict && (
            <button
              className="secondary-action-button camera-dialog__action"
              onClick={() => {
                closeDialog();
                onConflict();
              }}
              type="button"
            >
              Tutup dan periksa riwayat absensi
            </button>
          )}
        </div>
      )}
      {busy && (
        <p className="camera-dialog__status" role="status" aria-live="polite">
          {submissionState === 'preparing'
            ? 'Menyiapkan tautan unggah privat…'
            : submissionState === 'uploading'
              ? 'Mengunggah foto ke penyimpanan privat…'
              : 'Menunggu receipt absensi dari server…'}
        </p>
      )}

      <p className="camera-dialog__local-note" role="note">
        Saat offline, simpanan lokal terenkripsi tetap belum tersinkron dan bukan bukti server.
        Absensi hanya dianggap diterima setelah receipt server yang sah.
      </p>

      <div className="camera-dialog__actions">
        {(snapshot.status === 'idle' || hasError) && (
          <button
            className="primary-button camera-dialog__action"
            onClick={() => void controller.start()}
            ref={enableCameraRef}
            type="button"
          >
            {snapshot.status === 'idle' ? 'Aktifkan kamera' : 'Coba lagi'}
          </button>
        )}
        {snapshot.status === 'ready' && (
          <button
            className="primary-button camera-dialog__action"
            disabled={!videoReady || !['passed', 'unsupported'].includes(snapshot.liveness.status)}
            onClick={() => void handleCapture()}
            type="button"
          >
            {videoReady ? 'Ambil selfie' : 'Menyiapkan kamera…'}
          </button>
        )}
        {canSubmit && (
          <button
            className="primary-button camera-dialog__action"
            disabled={busy}
            onClick={() => void submitAttendance()}
            type="button"
          >
            {busy
              ? 'Mengirim…'
              : attemptDraftRef.current
                ? 'Kirim ulang dengan kunci yang sama'
                : retryAllowed
                  ? 'Coba unggah dan kirim lagi'
                  : typeof navigator !== 'undefined' && navigator.onLine === false
                    ? 'Simpan terenkripsi sebagai antrean offline'
                    : `Kirim absen ${actionLabel}`}
          </button>
        )}
        {canRetake && (
          <button
            className="secondary-action-button camera-dialog__action"
            onClick={retakePhoto}
            ref={enableCameraRef}
            type="button"
          >
            Ambil foto baru
          </button>
        )}
        <button
          className="secondary-action-button camera-dialog__action"
          onClick={closeDialog}
          type="button"
        >
          Selesai
        </button>
      </div>
    </dialog>
  );
}
