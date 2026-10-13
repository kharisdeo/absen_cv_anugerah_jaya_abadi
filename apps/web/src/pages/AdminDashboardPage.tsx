import { useId, useReducer, type ChangeEvent, type FormEvent } from 'react';

import {
  AdminDashboardApiError,
  type AdminDashboard,
  type DashboardLateRankingItem,
  type DashboardShiftItem,
  type DashboardStatus,
  type DashboardSummary,
  type DashboardTrendItem,
} from '../api/admin-dashboard-api.js';
import { toUserErrorMessage } from '../api/error-message.js';
import { Alert } from '../components/ui/Alert.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState, LoadingState } from '../components/ui/AsyncState.js';
import { TextField } from '../components/ui/TextField.js';
import {
  INITIAL_ADMIN_DASHBOARD_FILTERS,
  reduceAdminDashboardFilters,
  type AdminDashboardFilters,
} from './admin-dashboard-model.js';
import {
  useAdminDashboard,
  useAdminDashboardOptions,
  type AdminDashboardDataState,
  type AdminDashboardOptionsState,
} from './use-admin-dashboard.js';
import './admin-dashboard.css';

const PAGE_SIZE = 25;

const KPI_FIELDS = [
  ['present', 'Hadir'],
  ['late', 'Terlambat'],
  ['notCheckedIn', 'Belum check-in'],
  ['absent', 'Tidak hadir'],
  ['leave', 'Izin'],
  ['sick', 'Sakit'],
  ['annualLeave', 'Cuti tahunan'],
  ['waitingVerification', 'Perlu verifikasi'],
] as const satisfies readonly (readonly [keyof DashboardSummary, string])[];

const STATUS_LABELS: Readonly<Record<DashboardStatus, string>> = {
  PRESENT: 'Hadir',
  LATE: 'Terlambat',
  NOT_CHECKED_IN: 'Belum check-in',
  ABSENT: 'Tidak hadir',
  LEAVE: 'Izin',
  SICK: 'Sakit',
  ANNUAL_LEAVE: 'Cuti tahunan',
  WAITING_VERIFICATION: 'Perlu verifikasi',
  REQUEST_PENDING: 'Pengajuan menunggu',
  HOLIDAY: 'Hari libur',
  EARLY_LEAVE: 'Pulang lebih awal',
  MISSING_CHECKOUT: 'Belum check-out',
  UNATTRIBUTED_ATTENDANCE: 'Absensi belum teratribusi',
};

const MONTHS_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const;

function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return value;
  return `${Number(match[3])} ${MONTHS_ID[month - 1]} ${match[1]}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(value);
}

function formatMinutes(value: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(value);
}

function statusTone(status: DashboardStatus): string {
  if (status === 'PRESENT') return 'positive';
  if (status === 'LATE' || status === 'ABSENT') return 'warning';
  if (status === 'WAITING_VERIFICATION') return 'pending';
  return 'neutral';
}

function AdminDashboardError({
  error,
  selectedDate,
  onRetry,
}: Readonly<{ error: unknown; selectedDate: string; onRetry: () => void }>) {
  const message =
    error instanceof AdminDashboardApiError &&
    error.code === 'INVALID_DASHBOARD_INPUT' &&
    selectedDate
      ? 'Tanggal tidak valid atau berada setelah tanggal bisnis server. Pilih tanggal lain, atau kosongkan filter untuk Hari ini (tanggal server).'
      : toUserErrorMessage(error);
  return (
    <section className="admin-dashboard-error" role="alert" aria-live="assertive">
      <h2>Dashboard belum dapat dimuat</h2>
      <p>{message}</p>
      <Button onClick={onRetry} variant="secondary">
        Coba lagi
      </Button>
    </section>
  );
}

function DashboardFilters({
  filters,
  options,
  onChange,
  onRetryOptions,
}: Readonly<{
  filters: AdminDashboardFilters;
  options: AdminDashboardOptionsState;
  onChange: (action: Parameters<typeof reduceAdminDashboardFilters>[1]) => void;
  onRetryOptions: () => void;
}>) {
  const dateId = useId();
  const storeId = useId();
  const shiftId = useId();

  function changeDate(event: ChangeEvent<HTMLInputElement>) {
    onChange({ type: 'date', value: event.currentTarget.value });
  }
  function changeStore(event: ChangeEvent<HTMLSelectElement>) {
    onChange({ type: 'store', value: event.currentTarget.value });
  }
  function changeShift(event: ChangeEvent<HTMLSelectElement>) {
    onChange({ type: 'shift', value: event.currentTarget.value });
  }

  return (
    <section
      className="admin-dashboard-panel admin-dashboard-filters"
      aria-labelledby="dashboard-filters-title"
    >
      <div className="admin-dashboard-panel__heading">
        <div>
          <span className="section-kicker">FILTER DATA</span>
          <h2 id="dashboard-filters-title">Ruang lingkup dashboard</h2>
        </div>
      </div>
      <form
        className="admin-dashboard-filters__fields"
        onSubmit={(event: FormEvent) => event.preventDefault()}
      >
        <TextField
          id={dateId}
          label="Tanggal"
          type="date"
          value={filters.date}
          onChange={changeDate}
          hint={
            filters.date
              ? 'Tanggal kalender; tidak dikonversi dari waktu browser.'
              : 'Hari ini (tanggal server)'
          }
        />
        <div className="ds-field">
          <label className="ds-field__label" htmlFor={storeId}>
            Toko
          </label>
          <select
            className="ds-input"
            id={storeId}
            value={filters.storeId}
            onChange={changeStore}
            disabled={options.stores.status === 'loading' && options.stores.items.length === 0}
          >
            <option value="">Semua toko</option>
            {options.stores.items.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
                {store.isActive ? '' : ' (nonaktif)'}
              </option>
            ))}
          </select>
          {options.stores.status === 'loading' && (
            <span className="ds-field__hint">Memuat daftar toko…</span>
          )}
        </div>
        <div className="ds-field">
          <label className="ds-field__label" htmlFor={shiftId}>
            Shift
          </label>
          <select
            className="ds-input"
            id={shiftId}
            value={filters.shiftId}
            onChange={changeShift}
            disabled={options.shifts.status === 'loading' && options.shifts.items.length === 0}
          >
            <option value="">Semua shift</option>
            {options.shifts.items.map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.name}
                {shift.isActive ? '' : ' (nonaktif)'}
              </option>
            ))}
          </select>
          {options.shifts.status === 'loading' && (
            <span className="ds-field__hint">Memuat daftar shift…</span>
          )}
        </div>
      </form>
      {(options.stores.status === 'error' || options.shifts.status === 'error') && (
        <div className="admin-dashboard-option-errors">
          {options.stores.status === 'error' && (
            <Alert tone="warning" title="Daftar toko belum dapat dimuat">
              <p>{toUserErrorMessage(options.stores.error)}</p>
              <Button onClick={onRetryOptions} variant="secondary">
                Coba lagi
              </Button>
            </Alert>
          )}
          {options.shifts.status === 'error' && (
            <Alert tone="warning" title="Daftar shift belum dapat dimuat">
              <p>{toUserErrorMessage(options.shifts.error)}</p>
              <Button onClick={onRetryOptions} variant="secondary">
                Coba lagi
              </Button>
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}

function KpiCards({ summary }: Readonly<{ summary: DashboardSummary }>) {
  return (
    <section className="admin-dashboard-kpis" aria-label="Ringkasan status kehadiran">
      {KPI_FIELDS.map(([field, label]) => (
        <article className="admin-dashboard-kpi" key={field}>
          <span>{label}</span>
          <strong>{formatCount(summary[field])}</strong>
        </article>
      ))}
    </section>
  );
}

function TrendChart({ trend }: Readonly<{ trend: readonly DashboardTrendItem[] }>) {
  const maxScheduled = Math.max(1, ...trend.map((day) => day.scheduledShifts));
  const firstDate = trend[0]?.date;
  const lastDate = trend[trend.length - 1]?.date;
  return (
    <figure className="admin-dashboard-trend" aria-labelledby="dashboard-trend-title">
      <div className="admin-dashboard-trend__legend" aria-label="Legenda grafik">
        <span>
          <i
            className="admin-dashboard-trend__swatch admin-dashboard-trend__swatch--present"
            aria-hidden="true"
          />
          Hadir
        </span>
        <span>
          <i
            className="admin-dashboard-trend__swatch admin-dashboard-trend__swatch--late"
            aria-hidden="true"
          />
          Terlambat
        </span>
      </div>
      <div className="admin-dashboard-trend__chart" aria-hidden="true">
        {trend.map((day) => (
          <div className="admin-dashboard-trend__column" key={day.date}>
            <div className="admin-dashboard-trend__bar" title={formatDateOnly(day.date)}>
              <span
                className="admin-dashboard-trend__bar-part admin-dashboard-trend__bar-part--present"
                style={{ height: `${(day.present / maxScheduled) * 100}%` }}
              />
              <span
                className="admin-dashboard-trend__bar-part admin-dashboard-trend__bar-part--late"
                style={{ height: `${(day.late / maxScheduled) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="admin-dashboard-trend__range" aria-hidden="true">
        <span>{firstDate ? formatDateOnly(firstDate) : '—'}</span>
        <span>{lastDate ? formatDateOnly(lastDate) : '—'}</span>
      </div>
      <details className="admin-dashboard-trend__data">
        <summary>Lihat angka lengkap untuk 30 hari</summary>
        <ol aria-label="Angka tren kehadiran dan keterlambatan selama 30 hari">
          {trend.map((day) => (
            <li key={day.date}>
              <strong>{formatDateOnly(day.date)}</strong>
              <span>Hadir: {formatCount(day.present)}</span>
              <span>Terlambat: {formatCount(day.late)}</span>
              <span>Belum check-in: {formatCount(day.notCheckedIn)}</span>
              <span>Tidak hadir: {formatCount(day.absent)}</span>
            </li>
          ))}
        </ol>
      </details>
      <figcaption>
        Tiap batang menampilkan jumlah shift hadir dan terlambat; angka per tanggal tersedia pada
        rincian.
      </figcaption>
    </figure>
  );
}

function LateRanking({ items }: Readonly<{ items: readonly DashboardLateRankingItem[] }>) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="Belum ada peringkat keterlambatan"
        description="Belum ada catatan terlambat dalam rentang tren yang dikirim server."
      />
    );
  }
  return (
    <ol className="admin-dashboard-ranking" aria-label="Peringkat keterlambatan dari API">
      {items.map((item, index) => (
        <li className="admin-dashboard-ranking__item" key={item.employeeId}>
          <span className="admin-dashboard-ranking__position" aria-label={`Peringkat ${index + 1}`}>
            {index + 1}
          </span>
          <div className="admin-dashboard-ranking__person">
            <strong>{item.employeeName}</strong>
            <span>
              {formatCount(item.lateCount)} shift terlambat · {formatCount(item.lateDays)} hari
              berbeda
            </span>
          </div>
          <span className="admin-dashboard-ranking__minutes">
            {formatMinutes(item.totalMinutesAfterScheduledStart)} menit
            <small>sejak jadwal mulai, termasuk toleransi</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

function NotCheckedInList({
  page,
  onPageChange,
}: Readonly<{
  page: AdminDashboard['notCheckedIn'];
  onPageChange: (page: number) => void;
}>) {
  if (page.items.length === 0) {
    return (
      <EmptyState
        title="Tidak ada karyawan dalam daftar"
        description="API tidak mengembalikan shift berstatus belum check-in atau tidak hadir untuk filter ini."
      />
    );
  }
  return (
    <div className="admin-dashboard-absent-list">
      <ul aria-label="Shift belum check-in atau tidak hadir">
        {page.items.map((item: DashboardShiftItem) => (
          <li className="admin-dashboard-absent-item" key={item.shiftAssignmentId}>
            <div className="admin-dashboard-absent-item__person">
              <strong>{item.employeeName}</strong>
              <span>
                {item.shiftName} · {item.store?.name ?? 'Toko tidak tercatat'}
              </span>
              <span>
                {formatDateOnly(item.date)} · Jadwal {item.scheduledStartTime}–
                {item.scheduledEndTime}
              </span>
            </div>
            <span
              className={`admin-dashboard-status admin-dashboard-status--${statusTone(item.status)}`}
            >
              {STATUS_LABELS[item.status]}
            </span>
          </li>
        ))}
      </ul>
      <nav className="admin-dashboard-pagination" aria-label="Halaman daftar belum check-in">
        <span aria-live="polite">
          Halaman {page.page} · {page.pageSize} per halaman
        </span>
        <div>
          <Button
            disabled={page.page <= 1}
            onClick={() => onPageChange(page.page - 1)}
            variant="secondary"
          >
            Sebelumnya
          </Button>
          <Button
            disabled={!page.hasNextPage}
            onClick={() => onPageChange(page.page + 1)}
            variant="secondary"
          >
            Berikutnya
          </Button>
        </div>
      </nav>
    </div>
  );
}

export function AdminDashboardView({
  state,
  filters,
  options,
  onFilterChange,
  onPageChange,
  onRefresh,
  onRetryOptions,
}: Readonly<{
  state: AdminDashboardDataState;
  filters: AdminDashboardFilters;
  options: AdminDashboardOptionsState;
  onFilterChange: (action: Parameters<typeof reduceAdminDashboardFilters>[1]) => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
  onRetryOptions: () => void;
}>) {
  const latestTrendDate =
    state.status === 'loaded' ? state.dashboard.trend.at(-1)?.date : undefined;
  return (
    <div className="admin-dashboard-page">
      <section className="admin-dashboard-intro">
        <div>
          <span className="section-kicker">OPERASIONAL · ADMIN</span>
          <h2>Ringkasan kehadiran</h2>
          <p>Pantau status shift, daftar yang perlu ditindaklanjuti, dan tren keterlambatan.</p>
        </div>
        <div className="admin-dashboard-intro__actions">
          <span className="admin-dashboard-date-label">
            {filters.date
              ? `Tanggal pilihan: ${formatDateOnly(filters.date)}`
              : 'Hari ini (tanggal server)'}
          </span>
          <Button
            disabled={state.status === 'loading' || (state.status === 'loaded' && state.refreshing)}
            loading={state.status === 'loaded' && state.refreshing}
            onClick={onRefresh}
            variant="secondary"
          >
            Perbarui sekarang
          </Button>
        </div>
      </section>

      <DashboardFilters
        filters={filters}
        options={options}
        onChange={onFilterChange}
        onRetryOptions={onRetryOptions}
      />

      <p className="admin-dashboard-poll-note" role="status">
        Data diperbarui otomatis setiap 60 detik selama halaman terlihat. Daftar toko dan shift
        tidak dipolling.
        {latestTrendDate
          ? ` Tanggal bisnis terakhir pada tren: ${formatDateOnly(latestTrendDate)}.`
          : ''}
      </p>

      {state.status === 'loading' && <LoadingState label="Memuat dashboard Admin…" />}
      {state.status === 'error' && (
        <AdminDashboardError error={state.error} selectedDate={filters.date} onRetry={onRefresh} />
      )}
      {state.status === 'loaded' && (
        <>
          <KpiCards summary={state.dashboard.summary} />
          {state.dashboard.summary.scheduledShifts === 0 &&
            state.dashboard.summary.pendingRequests === 0 && (
              <EmptyState
                title="Tidak ada jadwal untuk filter ini"
                description="Ringkasan menampilkan nilai yang dikirim API. Status Tidak hadir tidak disimpulkan hanya dari jam; status itu muncul jika API mengembalikan ABSENT."
              />
            )}
          <div className="admin-dashboard-grid">
            <section
              className="admin-dashboard-panel"
              aria-labelledby="dashboard-not-checked-title"
            >
              <div className="admin-dashboard-panel__heading">
                <div>
                  <span className="section-kicker">TINDAK LANJUT</span>
                  <h2 id="dashboard-not-checked-title">Belum check-in & tidak hadir</h2>
                </div>
                <span className="admin-dashboard-panel__count">
                  {formatCount(
                    state.dashboard.summary.notCheckedIn + state.dashboard.summary.absent,
                  )}{' '}
                  shift
                </span>
              </div>
              <NotCheckedInList page={state.dashboard.notCheckedIn} onPageChange={onPageChange} />
            </section>

            <section className="admin-dashboard-panel" aria-labelledby="dashboard-ranking-title">
              <div className="admin-dashboard-panel__heading">
                <div>
                  <span className="section-kicker">30 HARI</span>
                  <h2 id="dashboard-ranking-title">Peringkat keterlambatan</h2>
                </div>
              </div>
              <p className="admin-dashboard-panel__description">
                Urutan mengikuti API: jumlah shift terlambat, lalu total menit sejak jadwal mulai
                termasuk toleransi. Bukan menit bersih setelah toleransi.
              </p>
              <LateRanking items={state.dashboard.lateRanking} />
            </section>

            <section
              className="admin-dashboard-panel admin-dashboard-panel--trend"
              aria-labelledby="dashboard-trend-title"
            >
              <div className="admin-dashboard-panel__heading">
                <div>
                  <span className="section-kicker">TREN 30 HARI</span>
                  <h2 id="dashboard-trend-title">Kehadiran dan keterlambatan</h2>
                </div>
                {latestTrendDate && (
                  <span className="admin-dashboard-panel__count">
                    s.d. {formatDateOnly(latestTrendDate)}
                  </span>
                )}
              </div>
              <TrendChart trend={state.dashboard.trend} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export function AdminDashboardPage() {
  const [filters, dispatch] = useReducer(
    reduceAdminDashboardFilters,
    INITIAL_ADMIN_DASHBOARD_FILTERS,
  );
  const query = {
    ...(filters.date ? { date: filters.date } : {}),
    ...(filters.storeId ? { storeId: filters.storeId } : {}),
    ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
    page: filters.page,
    pageSize: PAGE_SIZE,
  };
  const { state, refresh } = useAdminDashboard(query);
  const { options, retry: retryOptions } = useAdminDashboardOptions();

  return (
    <AdminDashboardView
      filters={filters}
      onFilterChange={dispatch}
      onPageChange={(page) => dispatch({ type: 'page', value: page })}
      onRefresh={refresh}
      onRetryOptions={retryOptions}
      options={options}
      state={state}
    />
  );
}
