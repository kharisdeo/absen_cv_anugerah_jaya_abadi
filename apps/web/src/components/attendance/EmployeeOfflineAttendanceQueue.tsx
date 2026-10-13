import { useCallback, useEffect, useRef, useState } from 'react';

import { toUserErrorMessage } from '../../api/error-message.js';
import type { AttendanceReceipt } from '../../api/attendance-api.js';
import type { SessionState } from '../../auth/session.js';
import { AttendanceReceiptNotice } from './AttendanceReceiptNotice.js';
import {
  OfflineAttendanceQueue,
  OfflineQueueError,
  type DecryptedOfflineAttendanceEntry,
} from './offline-attendance-queue.js';
import { syncOfflineAttendanceQueue } from './offline-attendance-sync.js';
import './offline-attendance-queue.css';

export type OfflineQueueViewRow =
  | Readonly<{
      id: string;
      kind: 'pending';
      type: 'CHECK_IN' | 'CHECK_OUT';
      clientRecordedAt: string;
    }>
  | Readonly<{
      id: string;
      kind: 'receipt';
      receipt: AttendanceReceipt;
    }>;

/** Project decrypted storage data into the minimum safe shape retained by React state. */
export function toOfflineQueueViewRow(entry: DecryptedOfflineAttendanceEntry): OfflineQueueViewRow {
  if (entry.payload.kind === 'receipt') {
    return { id: entry.id, kind: 'receipt', receipt: entry.payload.receipt };
  }

  return {
    id: entry.id,
    kind: 'pending',
    type: entry.payload.type,
    clientRecordedAt: entry.payload.clientRecordedAt,
  };
}

type EmployeeOfflineAttendanceQueueProps = Readonly<{
  employeeId: string;
  queue: OfflineAttendanceQueue;
  refreshSession: () => Promise<SessionState>;
  refreshKey: number;
  onReceipt: (receipt: AttendanceReceipt) => void;
}>;

function isVerifiedOwner(session: SessionState, employeeId: string): boolean {
  return (
    session.status === 'authenticated' &&
    session.user.role === 'EMPLOYEE' &&
    session.user.employeeId === employeeId &&
    session.user.deviceBindingStatus === 'APPROVED' &&
    !session.user.mustChangePassword &&
    !session.user.consentRequired
  );
}

function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function formatDeviceTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'waktu perangkat tidak terbaca';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(date);
}

function queueErrorMessage(error: unknown): string {
  if (!(error instanceof OfflineQueueError)) return toUserErrorMessage(error);
  switch (error.code) {
    case 'QUOTA':
      return 'Penyimpanan perangkat penuh. Absensi belum masuk antrean; kosongkan ruang dengan aman atau hubungi Admin.';
    case 'ENCRYPTION_UNAVAILABLE':
      return 'Perangkat tidak mendukung penyimpanan antrean terenkripsi. Absensi belum disimpan.';
    case 'CORRUPT':
      return 'Antrean terenkripsi tidak dapat dibuka. Data lokal dipertahankan dan tidak akan dikirim; hubungi Admin.';
    case 'OWNER_REQUIRED':
      return 'Sesi karyawan tidak dapat dipastikan. Antrean tidak dibuka atau dikirim.';
    case 'ACK_INVALID':
      return 'Receipt server belum dapat diverifikasi. Bukti terenkripsi tetap disimpan.';
    case 'INVALID_CAPTURE':
      return 'Data kamera atau GPS tidak memenuhi syarat antrean. Tidak ada absensi yang disimpan.';
    case 'UNAVAILABLE':
      return 'Penyimpanan aman tidak tersedia. Absensi belum masuk antrean.';
  }
}

function localQueueId(id: string): string {
  return id;
}

export function EmployeeOfflineAttendanceQueue({
  employeeId,
  queue,
  refreshSession,
  refreshKey,
  onReceipt,
}: EmployeeOfflineAttendanceQueueProps) {
  const [rows, setRows] = useState<OfflineQueueViewRow[]>([]);
  const [online, setOnline] = useState(browserIsOnline);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const activeRef = useRef(false);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadRows = useCallback(async () => {
    try {
      const entries = await queue.list(employeeId);
      if (!activeRef.current) return;
      // Never retain decrypted payload/body/GPS/photo data in React state.
      setRows(entries.map(toOfflineQueueViewRow));
    } catch (error) {
      if (activeRef.current) setNotice(queueErrorMessage(error));
    }
  }, [employeeId, queue]);

  const syncNow = useCallback(async () => {
    if (!activeRef.current || busyRef.current || !browserIsOnline()) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await syncOfflineAttendanceQueue({
        employeeId,
        queue,
        isOnline: () => navigator.onLine !== false,
        verifyOwner: async () => {
          if (!activeRef.current || controller.signal.aborted) return false;
          const session = await refreshSession();
          return activeRef.current && isVerifiedOwner(session, employeeId);
        },
        apiOptions: { signal: controller.signal },
        onReceipt: (receipt) => {
          if (activeRef.current) onReceipt(receipt);
        },
      });
      if (!activeRef.current) return;
      if (result.error) setNotice(queueErrorMessage(result.error));
      else if (result.stopped && browserIsOnline()) {
        setNotice(
          'Sesi belum dapat diverifikasi. Antrean terenkripsi tetap menunggu dan tidak dikirim.',
        );
      }
      await loadRows();
    } catch (error) {
      if (activeRef.current && !controller.signal.aborted) setNotice(queueErrorMessage(error));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }, [employeeId, loadRows, onReceipt, queue, refreshSession]);

  useEffect(() => {
    activeRef.current = true;
    const updateNetwork = () => {
      const nextOnline = navigator.onLine !== false;
      setOnline(nextOnline);
      if (nextOnline) void syncNow();
    };
    const becameVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void syncNow();
    };
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    document.addEventListener('visibilitychange', becameVisible);
    void loadRows().then(() => {
      if (navigator.onLine !== false) void syncNow();
    });

    return () => {
      activeRef.current = false;
      abortRef.current?.abort();
      window.removeEventListener('online', updateNetwork);
      window.removeEventListener('offline', updateNetwork);
      document.removeEventListener('visibilitychange', becameVisible);
    };
  }, [loadRows, refreshKey, syncNow]);

  return (
    <section className="section-block offline-queue" aria-labelledby="offline-queue-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">ANTREAN PERANGKAT</span>
          <h2 id="offline-queue-title">Absensi offline</h2>
        </div>
        <span className={`offline-queue__connection${online ? ' is-online' : ''}`} role="status">
          {online ? 'Jaringan terhubung' : 'Menunggu jaringan'}
        </span>
      </div>

      <p className="offline-queue__intro">
        Item tertunda dienkripsi di perangkat dan hanya dibuka untuk akun karyawan yang sama setelah
        sesi diperiksa ke server. Waktu perangkat bukan waktu resmi absensi.
      </p>

      {notice && (
        <p className="offline-queue__notice" role="alert">
          {notice}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="offline-queue__empty" role="status">
          Tidak ada item antrean lokal yang menunggu atau receipt lokal yang tersimpan.
        </p>
      ) : (
        <ul className="offline-queue__list">
          {rows.map((row) =>
            row.kind === 'pending' ? (
              <li className="offline-queue__item" key={row.id}>
                <div className="offline-queue__item-heading">
                  <strong>{row.type === 'CHECK_IN' ? 'Absen masuk' : 'Absen pulang'}</strong>
                  <span className="offline-queue__pending">Belum tersinkron</span>
                </div>
                <p>Waktu perangkat: {formatDeviceTime(row.clientRecordedAt)}</p>
                <small>ID antrean lokal (bukan kode bukti server): {localQueueId(row.id)}</small>
                <p>Belum ada receipt server; status absensi belum ditetapkan.</p>
              </li>
            ) : (
              <li className="offline-queue__item" key={row.id}>
                <div className="offline-queue__item-heading">
                  <strong>Receipt server</strong>
                  <span className="offline-queue__acknowledged">Diterima server</span>
                </div>
                <small>ID antrean lokal (bukan kode bukti server): {localQueueId(row.id)}</small>
                <AttendanceReceiptNotice receipt={row.receipt} />
              </li>
            ),
          )}
        </ul>
      )}

      <div className="offline-queue__actions">
        <button
          className="secondary-action-button"
          disabled={!online || busy || !rows.some((row) => row.kind === 'pending')}
          onClick={() => void syncNow()}
          type="button"
        >
          {busy ? 'Memeriksa sesi dan menyinkronkan…' : 'Sinkronkan antrean'}
        </button>
        <span role="note">
          Sinkronisasi berjalan saat aplikasi terbuka; Background Sync tidak digunakan.
        </span>
      </div>
    </section>
  );
}
