import { useId, useReducer, type ChangeEvent } from 'react';

import type { EmployeeDashboardPage, EmployeeHistoryItem } from '../api/employee-dashboard-api.js';
import { StatusBadge } from '../components/ui/StatusBadge.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { TextField } from '../components/ui/TextField.js';
import {
  INITIAL_EMPLOYEE_HISTORY_FILTER,
  reduceEmployeeHistoryFilter,
} from './employee-history-filter.js';
import { useEmployeeDashboard, type EmployeeDashboardLoadState } from './use-employee-dashboard.js';
import './employee-pages.css';

const HISTORY_PAGE_SIZE = 20;

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
    second: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(value));
}

function validationExplanation(status: EmployeeHistoryItem['validationStatus']): string | null {
  if (status === 'PENDING_OFFLINE') return 'Menunggu sinkronisasi dari antrean offline perangkat.';
  if (status === 'PENDING_VERIFICATION') return 'Menunggu pemeriksaan petugas berwenang.';
  return null;
}

export function EmployeeHistoryResults({
  state,
  onRetry,
  onPageChange,
}: Readonly<{
  state: EmployeeDashboardLoadState;
  onRetry: () => void;
  onPageChange: (page: number) => void;
}>) {
  if (state.status === 'loading') return <LoadingState label="Memuat riwayat absensi Anda…" />;
  if (state.status === 'error') {
    return <ErrorState error={state.error} onRetry={onRetry} title="Riwayat belum dapat dimuat" />;
  }

  const page: EmployeeDashboardPage<EmployeeHistoryItem> = state.dashboard.history;
  if (page.items.length === 0) {
    return (
      <EmptyState
        title="Belum ada riwayat absensi"
        description="Tidak ada catatan yang sesuai dengan rentang tanggal pilihan Anda."
      />
    );
  }

  return (
    <div className="employee-history-list">
      <ul className="employee-history-list__items" aria-label="Riwayat absensi pribadi">
        {page.items.map((item) => (
          <li className="employee-history-card" key={item.id}>
            <div className="employee-history-card__heading">
              <div>
                <span className="section-kicker">
                  {item.type === 'CHECK_IN' ? 'ABSEN MASUK' : 'ABSEN PULANG'}
                </span>
                <h3>{formatWorkDate(item.date)}</h3>
              </div>
              <StatusBadge domain="validation" status={item.validationStatus} />
            </div>
            {validationExplanation(item.validationStatus) && (
              <p className="employee-history-card__status-note">
                {validationExplanation(item.validationStatus)}
              </p>
            )}
            <dl className="employee-history-card__details">
              <div>
                <dt>Waktu server</dt>
                <dd>{formatServerTime(item.serverTime)} WIB</dd>
              </div>
              <div>
                <dt>Shift</dt>
                <dd>{item.shift?.name ?? 'Shift belum tersedia'}</dd>
              </div>
              <div>
                <dt>Toko</dt>
                <dd>{item.store?.name ?? 'Lokasi belum tersedia'}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <nav className="employee-feature-pagination" aria-label="Halaman riwayat absensi">
        <span aria-live="polite">
          Halaman {page.page} · {page.pageSize} catatan per halaman
        </span>
        <div className="employee-feature-pagination__actions">
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

export function EmployeeHistoryPage() {
  const [filters, dispatch] = useReducer(
    reduceEmployeeHistoryFilter,
    INITIAL_EMPLOYEE_HISTORY_FILTER,
  );
  const fromId = useId();
  const toId = useId();
  const { state, retry } = useEmployeeDashboard({
    historyPage: filters.page,
    historyPageSize: HISTORY_PAGE_SIZE,
    ...(filters.from ? { historyFrom: filters.from } : {}),
    ...(filters.to ? { historyTo: filters.to } : {}),
  });

  function changeFrom(event: ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'from', value: event.currentTarget.value });
  }

  function changeTo(event: ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'to', value: event.currentTarget.value });
  }

  return (
    <div className="employee-feature-page">
      <section className="employee-feature-intro">
        <span className="section-kicker">CATATAN PRIBADI</span>
        <h2>Riwayat absensi</h2>
        <p>Catatan dan status ditampilkan sesuai data yang dikirim server.</p>
      </section>
      <section
        className="section-block employee-history-filters"
        aria-labelledby="history-filter-title"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">FILTER TANGGAL</span>
            <h2 id="history-filter-title">Pilih rentang riwayat</h2>
          </div>
        </div>
        <div className="employee-history-filters__fields">
          <TextField
            id={fromId}
            label="Dari tanggal"
            onChange={changeFrom}
            type="date"
            value={filters.from}
          />
          <TextField
            id={toId}
            label="Sampai tanggal"
            onChange={changeTo}
            type="date"
            value={filters.to}
          />
        </div>
        <p className="employee-feature-hint">
          Filter berlaku pada tanggal kerja riwayat saja; jadwal hari ini dan pengajuan tidak
          berubah.
        </p>
        <div className="employee-history-filters__actions">
          <Button
            disabled={!filters.from && !filters.to}
            onClick={() => dispatch({ type: 'reset' })}
            variant="secondary"
          >
            Hapus filter
          </Button>
        </div>
      </section>
      <section className="section-block" aria-label="Hasil riwayat absensi">
        <EmployeeHistoryResults
          onPageChange={(page) => dispatch({ type: 'page', value: page })}
          onRetry={retry}
          state={state}
        />
      </section>
    </div>
  );
}
