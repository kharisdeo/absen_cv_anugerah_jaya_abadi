import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';

import type {
  NotificationDto,
  NotificationKind,
  NotificationReadFilter,
} from '../api/notifications-api.js';
import { toUserErrorMessage } from '../api/error-message.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { NotificationsModel } from './notifications-model.js';
import './notifications.css';

const KIND_LABELS: Readonly<Record<NotificationKind, string>> = {
  ATTENDANCE_VERIFICATION: 'Verifikasi absensi',
  ATTENDANCE_REQUEST: 'Pengajuan absensi',
  REQUEST_DECISION: 'Keputusan pengajuan',
  CORRECTION_DECISION: 'Keputusan koreksi',
  SYSTEM_DISRUPTION: 'Gangguan sistem',
  RECAP_CLOSED: 'Rekap bulanan',
};

const READ_FILTER_LABELS: Readonly<Record<NotificationReadFilter, string>> = {
  ALL: 'Semua notifikasi',
  UNREAD: 'Belum dibaca',
  READ: 'Sudah dibaca',
};

function formatNotificationDate(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(value));
}

function NotificationItem({
  item,
  busy,
  onMarkRead,
}: Readonly<{
  item: NotificationDto;
  busy: boolean;
  onMarkRead: (notificationId: string) => void;
}>) {
  const isRead = item.readAt !== null;
  return (
    <li className={`notification-item${isRead ? ' notification-item--read' : ''}`}>
      <div className="notification-item__topline">
        <span className="notification-item__kind">{KIND_LABELS[item.kind]}</span>
        {!isRead && <span className="notification-unread-dot">Belum dibaca</span>}
      </div>
      <h2>{item.title}</h2>
      <p>{item.message}</p>
      <div className="notification-item__footer">
        <time dateTime={item.createdAt}>{formatNotificationDate(item.createdAt)} WIB</time>
        {!isRead && (
          <Button
            disabled={busy}
            loading={busy}
            onClick={() => onMarkRead(item.id)}
            variant="quiet"
          >
            Tandai dibaca
          </Button>
        )}
      </div>
    </li>
  );
}

export function NotificationsPage() {
  const model = useMemo(() => new NotificationsModel(), []);
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getServerSnapshot,
  );
  const filterId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void model.load(controller.signal);
    return () => controller.abort();
  }, [model, snapshot.readFilter, snapshot.page, snapshot.pageSize, snapshot.refreshVersion]);

  return (
    <section className="notifications-page" aria-labelledby="notifications-heading">
      <header className="notifications-header">
        <div>
          <p className="eyebrow">PUSAT INFORMASI</p>
          <h1 id="notifications-heading">Notifikasi</h1>
          <p>Perkembangan pengajuan dan verifikasi untuk akun Anda.</p>
        </div>
        <div className="notifications-unread-count" aria-live="polite" role="status">
          <strong>{snapshot.unreadCount}</strong>
          <span>belum dibaca</span>
        </div>
      </header>

      <section className="notifications-panel" aria-label="Daftar notifikasi">
        <div className="notifications-toolbar">
          <div className="notifications-filter">
            <label htmlFor={filterId}>Tampilkan</label>
            <select
              id={filterId}
              onChange={(event) =>
                model.setReadFilter(event.target.value as NotificationReadFilter)
              }
              value={snapshot.readFilter}
            >
              {(['ALL', 'UNREAD', 'READ'] as const).map((filter) => (
                <option key={filter} value={filter}>
                  {READ_FILTER_LABELS[filter]}
                </option>
              ))}
            </select>
          </div>
          {snapshot.status === 'ready' && (
            <span className="notifications-page-count">
              Halaman {snapshot.page} · {snapshot.items.length} notifikasi
            </span>
          )}
        </div>

        {snapshot.actionError !== null && (
          <Alert tone="danger" title="Status baca belum diperbarui">
            {toUserErrorMessage(snapshot.actionError)}
          </Alert>
        )}

        {snapshot.status === 'loading' && <LoadingState label="Memuat notifikasi…" />}
        {snapshot.status === 'error' && (
          <ErrorState error={snapshot.error} onRetry={() => model.requestRefresh()} />
        )}
        {snapshot.status === 'ready' && snapshot.items.length === 0 && (
          <EmptyState
            title="Belum ada notifikasi"
            description="Notifikasi baru akan tampil di sini saat ada pengajuan atau verifikasi terkait akun Anda."
          />
        )}
        {snapshot.status === 'ready' && snapshot.items.length > 0 && (
          <>
            <ul className="notification-list" aria-label="Notifikasi akun">
              {snapshot.items.map((item) => (
                <NotificationItem
                  busy={snapshot.busyNotificationId === item.id}
                  item={item}
                  key={item.id}
                  onMarkRead={(id) => void model.markRead(id)}
                />
              ))}
            </ul>
            <nav className="notifications-pagination" aria-label="Paginasi notifikasi">
              <Button
                disabled={snapshot.page <= 1}
                onClick={() => model.goToPage(snapshot.page - 1)}
                variant="secondary"
              >
                Sebelumnya
              </Button>
              <span aria-live="polite">Halaman {snapshot.page}</span>
              <Button
                disabled={!snapshot.hasNextPage}
                onClick={() => model.goToPage(snapshot.page + 1)}
                variant="secondary"
              >
                Berikutnya
              </Button>
            </nav>
          </>
        )}
      </section>
    </section>
  );
}
