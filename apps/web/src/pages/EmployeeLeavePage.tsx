import { Link } from 'react-router-dom';

import type {
  EmployeeDashboardPage,
  EmployeeRequestStatusItem,
} from '../api/employee-dashboard-api.js';
import { StatusBadge } from '../components/ui/StatusBadge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import { useEmployeeDashboard, type EmployeeDashboardLoadState } from './use-employee-dashboard.js';
import './employee-pages.css';

const REQUEST_SUMMARY_PAGE_SIZE = 5;

function formatWorkDate(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function requestTypeLabel(type: EmployeeRequestStatusItem['requestType']): string {
  switch (type) {
    case 'LEAVE':
      return 'Izin';
    case 'SICK':
      return 'Sakit';
    case 'ANNUAL_LEAVE':
      return 'Cuti tahunan';
    case 'OVERTIME':
      return 'Lembur';
    case 'CORRECTION':
      return 'Koreksi absensi';
  }
}

export function EmployeeLeaveRequestSummary({
  state,
  onRetry,
}: Readonly<{ state: EmployeeDashboardLoadState; onRetry: () => void }>) {
  if (state.status === 'loading') return <LoadingState label="Memuat status pengajuan terbaru…" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        error={state.error}
        onRetry={onRetry}
        title="Status pengajuan belum dapat dimuat"
      />
    );
  }

  const page: EmployeeDashboardPage<EmployeeRequestStatusItem> = state.dashboard.requests;
  if (page.items.length === 0) {
    return (
      <EmptyState
        title="Belum ada pengajuan"
        description="Status pengajuan pribadi akan muncul di sini setelah Anda mengirimnya."
        action={
          <Link className="ds-button ds-button--secondary" to="/employee/requests">
            Buka pengajuan saya
          </Link>
        }
      />
    );
  }

  return (
    <div className="employee-leave-requests">
      <ul
        className="employee-leave-requests__items"
        aria-label="Ringkasan status pengajuan pribadi"
      >
        {page.items.map((item) => (
          <li className="employee-leave-request-row" key={item.id}>
            <div>
              <h3>{requestTypeLabel(item.requestType)}</h3>
              <p>
                {formatWorkDate(item.startDate)}
                {item.endDate !== item.startDate && <> – {formatWorkDate(item.endDate)}</>}
              </p>
            </div>
            <StatusBadge domain="request" status={item.status} />
          </li>
        ))}
      </ul>
      <p className="employee-feature-hint">
        Menampilkan paling banyak {page.pageSize} pengajuan terbaru, tanpa alasan atau lampiran.
      </p>
      <Link className="ds-button ds-button--secondary" to="/employee/requests">
        Lihat semua dan ajukan
      </Link>
    </div>
  );
}

export function EmployeeLeavePage() {
  const { state, retry } = useEmployeeDashboard({ requestPageSize: REQUEST_SUMMARY_PAGE_SIZE });
  return (
    <div className="employee-feature-page">
      <section className="employee-feature-intro">
        <span className="section-kicker">INFORMASI CUTI</span>
        <h2>Cuti dan pengajuan</h2>
        <p>Informasi saldo hanya ditampilkan jika tersedia dari sumber data resmi.</p>
      </section>
      <section className="employee-leave-balance" aria-labelledby="leave-balance-title">
        <span className="section-kicker">SALDO CUTI</span>
        <h2 id="leave-balance-title">Saldo cuti belum tersedia</h2>
        <p>
          Sumber kuota dan aturan akrual/carry-over belum ditetapkan. Karena itu aplikasi tidak
          menampilkan angka saldo atau perkiraan.
        </p>
        <Link className="ds-button ds-button--primary" to="/employee/requests">
          Ajukan atau cek status pengajuan
        </Link>
      </section>
      <section className="section-block" aria-labelledby="employee-leave-requests-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">STATUS PRIBADI</span>
            <h2 id="employee-leave-requests-title">Pengajuan terbaru</h2>
          </div>
        </div>
        <EmployeeLeaveRequestSummary onRetry={retry} state={state} />
      </section>
    </div>
  );
}
