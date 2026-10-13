import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  monthlyReportApi,
  type DailyReportDetail,
  type MonthlyReport,
  type MonthlyReportQuery,
  type MonthlyReportSummary,
} from '../api/monthly-report-api.js';
import { adminEmployeesApi, type EmployeeDto } from '../api/admin-employees-api.js';
import { adminStoresApi, type StoreDto } from '../api/admin-stores-api.js';
import { toUserErrorMessage } from '../api/error-message.js';
import type { UserRole } from '../auth/session.js';
import { Alert } from '../components/ui/Alert.js';
import { ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { Button } from '../components/ui/Button.js';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable.js';
import {
  currentJakartaMonth,
  formatReportDate,
  formatReportInstant,
  formatReportMinutes,
  formatReportCount,
  MONTHLY_REPORT_STATUS_LABELS,
} from './monthly-report-model.js';
import './monthly-report.css';

const DETAIL_PAGE_SIZE = 50;
const STATUS_LABELS = {
  VALID: 'Valid',
  APPROVED: 'Disetujui',
  PENDING_VERIFICATION: 'Menunggu verifikasi',
  PENDING_OFFLINE: 'Menunggu verifikasi offline',
  REJECTED: 'Ditolak',
  MIXED: 'Campuran',
} as const;

type ReportLoadState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'loaded'; report: MonthlyReport }>;

type OptionLoadState =
  | Readonly<{ status: 'loading'; stores: readonly StoreDto[]; employees: readonly EmployeeDto[] }>
  | Readonly<{
      status: 'error';
      stores: readonly StoreDto[];
      employees: readonly EmployeeDto[];
      error: unknown;
    }>
  | Readonly<{ status: 'loaded'; stores: readonly StoreDto[]; employees: readonly EmployeeDto[] }>;

type ScopedOptionsState =
  | Readonly<{
      status: 'loading';
      stores: readonly ScopedOption[];
      employees: readonly ScopedOption[];
    }>
  | Readonly<{
      status: 'error';
      stores: readonly ScopedOption[];
      employees: readonly ScopedOption[];
      error: unknown;
    }>
  | Readonly<{
      status: 'loaded';
      stores: readonly ScopedOption[];
      employees: readonly ScopedOption[];
    }>;

type ScopedOption = Readonly<{ id: string; name: string }>;
type FilterState = Readonly<{ month: string; storeId: string; employeeId: string }>;

function createInitialFilters(): FilterState {
  return { month: currentJakartaMonth(), storeId: '', employeeId: '' };
}

function reportQuery(filters: FilterState): MonthlyReportQuery {
  return {
    month: filters.month,
    ...(filters.storeId ? { storeId: filters.storeId } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
  };
}

function useMonthlyReport(role: 'ADMIN' | 'SUPERVISOR', filters: FilterState) {
  const [state, setState] = useState<ReportLoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const query = useMemo(
    () => reportQuery(filters),
    [filters.month, filters.storeId, filters.employeeId],
  );
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void monthlyReportApi
      .getMonthlyReport(query, { signal: controller.signal })
      .then((report) => {
        if (!controller.signal.aborted) setState({ status: 'loaded', report });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      });
    return () => controller.abort();
  }, [query, refreshKey, role]);

  return { state, refresh };
}

function useAdminReportOptions(enabled: boolean, retryKey: number) {
  const [state, setState] = useState<OptionLoadState>({
    status: 'loading',
    stores: [],
    employees: [],
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((current) => ({
      status: 'loading',
      stores: current.stores,
      employees: current.employees,
    }));
    void Promise.all([
      adminStoresApi.listStores(controller.signal),
      adminEmployeesApi.listEmployees(controller.signal),
    ])
      .then(([stores, employees]) => {
        if (!controller.signal.aborted) setState({ status: 'loaded', stores, employees });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((current) => ({
            status: 'error',
            stores: current.stores,
            employees: current.employees,
            error,
          }));
        }
      });
    return () => controller.abort();
  }, [enabled, retryKey]);
  return state;
}

function useSupervisorReportOptions(enabled: boolean, month: string, reportState: ReportLoadState) {
  const [state, setState] = useState<ScopedOptionsState>({
    status: 'loading',
    stores: [],
    employees: [],
  });
  useEffect(() => {
    if (!enabled) return;
    setState({ status: 'loading', stores: [], employees: [] });
  }, [enabled, month]);
  useEffect(() => {
    if (!enabled) return;
    if (reportState.status === 'error') {
      setState((current) =>
        current.status === 'loaded'
          ? current
          : {
              status: 'error',
              stores: current.stores,
              employees: current.employees,
              error: reportState.error,
            },
      );
      return;
    }
    if (
      reportState.status === 'loaded' &&
      reportState.report.month === month &&
      reportState.report.filters.storeId === null &&
      reportState.report.filters.employeeId === null
    ) {
      const report = reportState.report;
      const stores = new Map<string, string>();
      for (const detail of report.dailyDetails) {
        if (detail.store) stores.set(detail.store.id, detail.store.name);
      }
      setState({
        status: 'loaded',
        stores: [...stores]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'id')),
        employees: report.summary
          .map(({ employeeId: id, employeeName: name }) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'id')),
      });
    }
  }, [enabled, month, reportState]);
  return state;
}

function statusTone(status: DailyReportDetail['status']): string {
  if (status === 'PRESENT') return 'positive';
  if (status === 'LATE' || status === 'EARLY_LEAVE' || status === 'MISSING_CHECKOUT')
    return 'warning';
  if (status === 'WAITING_VERIFICATION' || status === 'REQUEST_PENDING') return 'pending';
  return 'neutral';
}

function validationLabel(status: DailyReportDetail['validationStatus']): string {
  return status ? STATUS_LABELS[status] : '—';
}

function SummaryTable({ rows }: Readonly<{ rows: readonly MonthlyReportSummary[] }>) {
  const columns: readonly DataTableColumn<MonthlyReportSummary>[] = [
    { key: 'employee', header: 'Karyawan', render: (row) => row.employeeName },
    { key: 'workDays', header: 'Hari kerja¹', render: (row) => formatReportCount(row.workDays) },
    { key: 'present', header: 'Shift hadir', render: (row) => formatReportCount(row.present) },
    { key: 'late', header: 'Shift terlambat', render: (row) => formatReportCount(row.lateCount) },
    {
      key: 'lateMinutes',
      header: 'Menit terlambat',
      render: (row) => formatReportMinutes(row.lateMinutes),
    },
    { key: 'absent', header: 'Tidak hadir', render: (row) => formatReportCount(row.absent) },
    { key: 'leave', header: 'Izin', render: (row) => formatReportCount(row.leave) },
    { key: 'sick', header: 'Sakit', render: (row) => formatReportCount(row.sick) },
    {
      key: 'annualLeave',
      header: 'Cuti tahunan',
      render: (row) => formatReportCount(row.annualLeave),
    },
    {
      key: 'workMinutes',
      header: 'Waktu kerja',
      render: (row) => formatReportMinutes(row.totalWorkMinutes),
    },
    {
      key: 'overtime',
      header: 'Lembur disetujui',
      render: (row) => formatReportMinutes(row.approvedOvertimeMinutes),
    },
  ];
  return (
    <DataTable
      label="Ringkasan kehadiran bulanan per karyawan"
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.employeeId}
      emptyMessage="Tidak ada ringkasan karyawan untuk filter bulan ini."
    />
  );
}

function DetailTable({ rows }: Readonly<{ rows: readonly DailyReportDetail[] }>) {
  const columns: readonly DataTableColumn<DailyReportDetail>[] = [
    { key: 'date', header: 'Tanggal', render: (row) => formatReportDate(row.date) },
    { key: 'employee', header: 'Karyawan', render: (row) => row.employeeName },
    { key: 'store', header: 'Toko', render: (row) => row.store?.name ?? 'Tidak tercatat' },
    { key: 'shift', header: 'Shift', render: (row) => row.shift.name },
    {
      key: 'checkIn',
      header: 'Check-in (WIB)',
      render: (row) => formatReportInstant(row.checkInAt),
    },
    {
      key: 'checkOut',
      header: 'Check-out (WIB)',
      render: (row) => formatReportInstant(row.checkOutAt),
    },
    {
      key: 'duration',
      header: 'Waktu kerja',
      render: (row) => formatReportMinutes(row.durationMinutes),
    },
    {
      key: 'late',
      header: 'Terlambat',
      render: (row) => formatReportMinutes(row.lateMinutesAfterScheduledStart),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <span className={`monthly-report-status monthly-report-status--${statusTone(row.status)}`}>
          {MONTHLY_REPORT_STATUS_LABELS[row.status]}
        </span>
      ),
    },
    {
      key: 'validation',
      header: 'Validasi absensi',
      render: (row) => validationLabel(row.validationStatus),
    },
  ];
  return (
    <DataTable
      label="Rincian kehadiran per tanggal dan shift"
      columns={columns}
      rows={rows}
      getRowKey={(row) => `${row.shift.assignmentId}:${row.date}`}
      emptyMessage="Tidak ada rincian shift untuk filter bulan ini."
    />
  );
}

function ReportFilters({
  role,
  filters,
  stores,
  employees,
  optionsLoading,
  onChange,
}: Readonly<{
  role: 'ADMIN' | 'SUPERVISOR';
  filters: FilterState;
  stores: readonly ScopedOption[];
  employees: readonly ScopedOption[];
  optionsLoading: boolean;
  onChange: (next: FilterState) => void;
}>) {
  return (
    <section className="monthly-report-panel" aria-labelledby="monthly-report-filter-title">
      <div className="monthly-report-panel__heading">
        <div>
          <span className="section-kicker">FILTER LAPORAN</span>
          <h2 id="monthly-report-filter-title">Pilih periode dan cakupan</h2>
        </div>
        {role === 'SUPERVISOR' && (
          <span className="monthly-report-scope">Cakupan mengikuti assignment server</span>
        )}
      </div>
      <div className="monthly-report-fields">
        <label className="ds-field">
          <span className="ds-field__label">Bulan</span>
          <input
            aria-label="Bulan laporan"
            className="ds-input"
            type="month"
            value={filters.month}
            onChange={(event) =>
              onChange({ month: event.target.value, storeId: '', employeeId: '' })
            }
          />
        </label>
        <label className="ds-field">
          <span className="ds-field__label">Toko</span>
          <select
            aria-label="Filter toko"
            className="ds-input"
            disabled={optionsLoading}
            value={filters.storeId}
            onChange={(event) => onChange({ ...filters, storeId: event.target.value })}
          >
            <option value="">Semua toko dalam cakupan</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ds-field">
          <span className="ds-field__label">Karyawan</span>
          <select
            aria-label="Filter karyawan"
            className="ds-input"
            disabled={optionsLoading}
            value={filters.employeeId}
            onChange={(event) => onChange({ ...filters, employeeId: event.target.value })}
          >
            <option value="">Semua karyawan dalam cakupan</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {optionsLoading && (
        <p className="monthly-report-hint" role="status">
          Memuat pilihan filter…
        </p>
      )}
    </section>
  );
}

function DetailPagination({
  page,
  pageCount,
  total,
  onChange,
}: Readonly<{ page: number; pageCount: number; total: number; onChange: (page: number) => void }>) {
  return (
    <nav className="monthly-report-pagination" aria-label="Halaman rincian laporan">
      <span aria-live="polite">
        {total === 0
          ? '0 rincian'
          : `Menampilkan ${(page - 1) * DETAIL_PAGE_SIZE + 1}–${Math.min(page * DETAIL_PAGE_SIZE, total)} dari ${formatReportCount(total)} rincian`}
      </span>
      <div>
        <Button disabled={page <= 1} onClick={() => onChange(page - 1)} variant="secondary">
          Sebelumnya
        </Button>
        <span>
          Halaman {page} dari {pageCount}
        </span>
        <Button disabled={page >= pageCount} onClick={() => onChange(page + 1)} variant="secondary">
          Berikutnya
        </Button>
      </div>
    </nav>
  );
}

function downloadReport(blob: Blob, month: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rekap-absensi-${month}.xlsx`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function MonthlyReportPage({
  role,
}: Readonly<{ role: Extract<UserRole, 'ADMIN' | 'SUPERVISOR'> }>) {
  const [filters, setFilters] = useState<FilterState>(createInitialFilters);
  const [tab, setTab] = useState<'summary' | 'detail'>('summary');
  const [page, setPage] = useState(1);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [exportState, setExportState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [exportError, setExportError] = useState<unknown>(null);
  const exportController = useRef<AbortController | null>(null);
  const { state, refresh } = useMonthlyReport(role, filters);
  const adminOptions = useAdminReportOptions(role === 'ADMIN', optionsRetry);
  const supervisorOptions = useSupervisorReportOptions(role === 'SUPERVISOR', filters.month, state);
  const options = role === 'ADMIN' ? adminOptions : supervisorOptions;

  useEffect(() => {
    setPage(1);
  }, [filters.month, filters.storeId, filters.employeeId, tab]);

  useEffect(() => () => exportController.current?.abort(), []);

  const storeOptions: readonly ScopedOption[] =
    role === 'ADMIN'
      ? adminOptions.stores.map(({ id, name, isActive }) => ({
          id,
          name: isActive ? name : `${name} (nonaktif)`,
        }))
      : supervisorOptions.stores;
  const employeeOptions: readonly ScopedOption[] =
    role === 'ADMIN'
      ? adminOptions.employees.map(({ id, fullName }) => ({ id, name: fullName }))
      : supervisorOptions.employees;
  const optionsLoading = options.status === 'loading';
  const optionsError = options.status === 'error' ? options.error : null;

  const retryAll = useCallback(() => {
    refresh();
    setOptionsRetry((key) => key + 1);
  }, [refresh]);

  async function onExport() {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportState('loading');
    setExportError(null);
    try {
      const blob = await monthlyReportApi.exportMonthlyReport(reportQuery(filters), {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) downloadReport(blob, filters.month);
      if (!controller.signal.aborted) setExportState('idle');
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setExportError(error);
        setExportState('error');
      }
    } finally {
      if (exportController.current === controller) exportController.current = null;
    }
  }

  const currentReport = state.status === 'loaded' ? state.report : null;
  const pageCount = currentReport
    ? Math.max(1, Math.ceil(currentReport.dailyDetails.length / DETAIL_PAGE_SIZE))
    : 1;
  const detailRows =
    currentReport?.dailyDetails.slice((page - 1) * DETAIL_PAGE_SIZE, page * DETAIL_PAGE_SIZE) ?? [];

  return (
    <div className="monthly-report-page">
      <section className="monthly-report-intro">
        <div>
          <span className="section-kicker">
            LAPORAN · {role === 'ADMIN' ? 'ADMIN' : 'SUPERVISOR'}
          </span>
          <h2>Laporan kehadiran</h2>
          <p>Rekap bulanan dan rincian shift berdasarkan data yang dihitung oleh server.</p>
        </div>
        <div className="monthly-report-intro__actions">
          {currentReport && (
            <span>
              {currentReport.month} · {formatReportCount(currentReport.summary.length)} karyawan
            </span>
          )}
          <Button
            disabled={!currentReport || exportState === 'loading'}
            loading={exportState === 'loading'}
            onClick={() => void onExport()}
            variant="primary"
          >
            Unduh Excel (.xlsx)
          </Button>
        </div>
      </section>

      <ReportFilters
        role={role}
        filters={filters}
        stores={storeOptions}
        employees={employeeOptions}
        optionsLoading={optionsLoading}
        onChange={setFilters}
      />

      {options.status === 'error' && (
        <Alert tone="warning" title="Pilihan filter belum dapat dimuat">
          <p>{toUserErrorMessage(optionsError)}</p>
          <Button onClick={() => setOptionsRetry((key) => key + 1)} variant="secondary">
            Coba muat ulang pilihan
          </Button>
        </Alert>
      )}
      {exportState === 'error' && (
        <Alert tone="danger" title="File laporan belum berhasil dibuat">
          <p>{toUserErrorMessage(exportError)}</p>
          <Button onClick={() => void onExport()} variant="secondary">
            Coba unduh lagi
          </Button>
        </Alert>
      )}

      {state.status === 'loading' && <LoadingState label="Memuat laporan bulanan…" />}
      {state.status === 'error' && (
        <ErrorState title="Laporan belum dapat dimuat" error={state.error} onRetry={retryAll} />
      )}
      {currentReport && (
        <section className="monthly-report-panel" aria-labelledby="monthly-report-results-title">
          <div className="monthly-report-panel__heading monthly-report-panel__heading--results">
            <div>
              <span className="section-kicker">HASIL LAPORAN</span>
              <h2 id="monthly-report-results-title">Periode {currentReport.month}</h2>
            </div>
            <div className="monthly-report-tabs" role="group" aria-label="Jenis tampilan laporan">
              <button
                aria-pressed={tab === 'summary'}
                className={tab === 'summary' ? 'is-active' : ''}
                onClick={() => setTab('summary')}
                type="button"
              >
                Ringkasan
              </button>
              <button
                aria-pressed={tab === 'detail'}
                className={tab === 'detail' ? 'is-active' : ''}
                onClick={() => setTab('detail')}
                type="button"
              >
                Detail shift
              </button>
            </div>
          </div>

          {tab === 'summary' ? (
            <>
              <SummaryTable rows={currentReport.summary} />
              <p className="monthly-report-footnote">
                ¹ Hari kerja menghitung tanggal kalender unik per karyawan. Dua shift pada tanggal
                yang sama tetap dihitung satu hari.
              </p>
              <details className="monthly-report-definitions">
                <summary>Definisi perhitungan</summary>
                <ul>
                  <li>
                    Hari kerja menghitung tanggal terjadwal non-libur yang sudah berjalan; tanggal
                    yang memiliki beberapa shift tetap satu hari.
                  </li>
                  <li>
                    Menit kerja berasal dari pasangan check-in/out valid atau disetujui, dibulatkan
                    ke menit terdekat, lalu dikurangi istirahat shift.
                  </li>
                  <li>Menit terlambat dihitung sejak waktu mulai shift, termasuk toleransi.</li>
                  <li>
                    Lembur hanya berasal dari pengajuan lembur yang disetujui Admin dan mengikuti
                    atribusi toko dari server.
                  </li>
                </ul>
              </details>
            </>
          ) : (
            <>
              <DetailTable rows={detailRows} />
              <DetailPagination
                page={page}
                pageCount={pageCount}
                total={currentReport.dailyDetails.length}
                onChange={setPage}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}
