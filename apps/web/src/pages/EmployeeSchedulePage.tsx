import type {
  EmployeeDashboardStatus,
  EmployeeDashboardTodayItem,
} from '../api/employee-dashboard-api.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { useEmployeeDashboard, type EmployeeDashboardLoadState } from './use-employee-dashboard.js';
import './employee-pages.css';

const STATUS_LABELS: Readonly<Record<EmployeeDashboardStatus, string>> = {
  PRESENT: 'Hadir',
  LATE: 'Terlambat',
  NOT_CHECKED_IN: 'Belum absen masuk',
  ABSENT: 'Tidak hadir',
  LEAVE: 'Izin',
  SICK: 'Sakit',
  ANNUAL_LEAVE: 'Cuti tahunan',
  WAITING_VERIFICATION: 'Menunggu verifikasi',
  REQUEST_PENDING: 'Pengajuan menunggu keputusan',
  HOLIDAY: 'Hari libur',
  EARLY_LEAVE: 'Pulang lebih awal',
  MISSING_CHECKOUT: 'Belum absen pulang',
  UNATTRIBUTED_ATTENDANCE: 'Absensi belum terhubung ke shift',
};

const STATUS_TONES: Readonly<Record<EmployeeDashboardStatus, string>> = {
  PRESENT: 'positive',
  LATE: 'warning',
  NOT_CHECKED_IN: 'neutral',
  ABSENT: 'negative',
  LEAVE: 'neutral',
  SICK: 'neutral',
  ANNUAL_LEAVE: 'neutral',
  WAITING_VERIFICATION: 'warning',
  REQUEST_PENDING: 'warning',
  HOLIDAY: 'neutral',
  EARLY_LEAVE: 'warning',
  MISSING_CHECKOUT: 'warning',
  UNATTRIBUTED_ATTENDANCE: 'warning',
};

function formatWorkDate(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function formatServerTime(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(value));
}

function followingCalendarDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function EmployeeScheduleCard({ item }: Readonly<{ item: EmployeeDashboardTodayItem }>) {
  const overnight = item.scheduledEndTime < item.scheduledStartTime;
  const endDate = overnight ? followingCalendarDate(item.date) : item.date;

  return (
    <li className="employee-schedule-card">
      <div className="employee-schedule-card__heading">
        <div>
          <span className="section-kicker">{formatWorkDate(item.date)}</span>
          <h3>{item.shiftName}</h3>
        </div>
        <span
          className={`employee-schedule-status employee-schedule-status--${STATUS_TONES[item.status]}`}
          aria-label={`Status: ${STATUS_LABELS[item.status]}`}
        >
          <span className="employee-schedule-status__dot" aria-hidden="true" />
          {STATUS_LABELS[item.status]}
        </span>
      </div>
      <dl className="employee-schedule-card__details">
        <div>
          <dt>Jadwal shift</dt>
          <dd>
            {item.scheduledStartTime.slice(0, 5)} – {item.scheduledEndTime.slice(0, 5)}
          </dd>
        </div>
        {overnight && (
          <div>
            <dt>Hari selesai</dt>
            <dd>Selesai pada hari kalender berikutnya, {formatWorkDate(endDate)}</dd>
          </div>
        )}
        <div>
          <dt>Toko</dt>
          <dd>{item.store?.name ?? 'Lokasi belum tersedia'}</dd>
        </div>
        {item.checkInAt && (
          <div>
            <dt>Masuk tercatat</dt>
            <dd>{formatServerTime(item.checkInAt)} WIB</dd>
          </div>
        )}
        {item.checkOutAt && (
          <div>
            <dt>Pulang tercatat</dt>
            <dd>{formatServerTime(item.checkOutAt)} WIB</dd>
          </div>
        )}
      </dl>
    </li>
  );
}

export function EmployeeScheduleResults({
  state,
  onRetry,
}: Readonly<{ state: EmployeeDashboardLoadState; onRetry: () => void }>) {
  if (state.status === 'loading') return <LoadingState label="Memuat jadwal hari ini…" />;
  if (state.status === 'error') {
    return <ErrorState error={state.error} onRetry={onRetry} title="Jadwal belum dapat dimuat" />;
  }
  if (state.dashboard.today.length === 0) {
    return (
      <EmptyState
        title="Belum ada shift hari ini"
        description="Tidak ada jadwal shift hari ini pada data yang diberikan server."
      />
    );
  }

  return (
    <ul className="employee-schedule-list" aria-label="Jadwal dan status shift hari ini">
      {state.dashboard.today.map((item) => (
        <EmployeeScheduleCard item={item} key={item.shiftAssignmentId} />
      ))}
    </ul>
  );
}

export function EmployeeSchedulePage() {
  const { state, retry } = useEmployeeDashboard({});
  return (
    <div className="employee-feature-page">
      <section className="employee-feature-intro">
        <span className="section-kicker">JADWAL KERJA</span>
        <h2>Jadwal hari ini</h2>
        <p>
          Jam shift adalah waktu lokal dari server. Halaman ini hanya menampilkan jadwal dan status
          untuk hari ini, bukan jadwal tanggal mendatang.
        </p>
      </section>
      <section className="section-block" aria-label="Jadwal shift hari ini">
        <EmployeeScheduleResults onRetry={retry} state={state} />
      </section>
    </div>
  );
}
