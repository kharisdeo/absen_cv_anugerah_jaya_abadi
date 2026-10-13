import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { useSession, type UserRole } from '../auth/session.js';
import { getRoleRoute } from '../app/role-navigation.js';
import { type AttendanceReceipt, type AttendanceType } from '../api/attendance-api.js';
import { AttendanceReceiptNotice } from '../components/attendance/AttendanceReceiptNotice.js';
import { CameraCaptureDialog } from '../components/attendance/CameraCaptureDialog.js';
import { EmployeeOfflineAttendanceQueue } from '../components/attendance/EmployeeOfflineAttendanceQueue.js';
import { OfflineAttendanceQueue } from '../components/attendance/offline-attendance-queue.js';
import { ErrorState, LoadingState } from '../components/ui/AsyncState.js';
import type { AdminDashboardDataState } from './use-admin-dashboard.js';
import { useAdminDashboard } from './use-admin-dashboard.js';
import { EmployeeScheduleResults } from './EmployeeSchedulePage.js';
import { useEmployeeDashboard } from './use-employee-dashboard.js';

type RoleHomeProps = Readonly<{ role: UserRole }>;

function FeaturePlaceholder({ title }: Readonly<{ title: string }>) {
  return (
    <section className="placeholder-card">
      <span className="section-kicker">SEDANG DISIAPKAN</span>
      <h2>{title}</h2>
      <p>Fitur ini belum tersedia. Tidak ada data yang dimuat atau disimpulkan pada halaman ini.</p>
      <Link className="quiet-link" to="..">
        Kembali ke ringkasan <span aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}

function EmptyDashboardMetric({
  title,
  description,
  icon,
}: Readonly<{ title: string; description: string; icon: string }>) {
  return (
    <article className="dashboard-empty-card">
      <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
        {icon}
      </span>
      <div>
        <h3>{title}</h3>
        <p role="status">{description}</p>
      </div>
    </article>
  );
}

export function EmployeeTodaySummary() {
  const { state, retry } = useEmployeeDashboard({});
  return <EmployeeScheduleResults onRetry={retry} state={state} />;
}

function EmployeeHome() {
  const navigate = useNavigate();
  const { session, refreshSession } = useSession();
  const employeeId =
    session.status === 'authenticated' && session.user.role === 'EMPLOYEE'
      ? session.user.employeeId
      : null;
  const [attendanceType, setAttendanceType] = useState<AttendanceType | null>(null);
  const [lastReceipt, setLastReceipt] = useState<AttendanceReceipt | null>(null);
  const [queueRefreshKey, setQueueRefreshKey] = useState(0);
  const [queue] = useState<OfflineAttendanceQueue | null>(() => {
    try {
      return new OfflineAttendanceQueue();
    } catch {
      return null;
    }
  });

  useEffect(() => () => queue?.close(), [queue]);

  function startAttendance(type: AttendanceType) {
    setLastReceipt(null);
    setAttendanceType(type);
  }

  return (
    <>
      {attendanceType && (
        <CameraCaptureDialog
          attendanceType={attendanceType}
          employeeId={employeeId}
          offlineQueue={queue}
          onClose={() => setAttendanceType(null)}
          onConflict={() => navigate('/employee/history')}
          onSubmitted={setLastReceipt}
          onQueued={() => setQueueRefreshKey((value) => value + 1)}
        />
      )}
      <section className="welcome-panel welcome-panel--employee">
        <div className="welcome-copy">
          <span className="section-kicker">HARI KERJA ANDA</span>
          <h2>
            Kehadiran rapi,
            <br />
            <em>kerja lebih berarti.</em>
          </h2>
          <p>
            Kamera depan dan GPS hanya diaktifkan saat Anda memilih absen. Status absensi ditentukan
            oleh receipt server.
          </p>
          <div className="attendance-actions" aria-label="Aksi absensi">
            <button
              className="primary-button"
              onClick={() => startAttendance('CHECK_IN')}
              type="button"
            >
              Absen masuk <span aria-hidden="true">→</span>
            </button>
            <button
              className="secondary-action-button"
              onClick={() => startAttendance('CHECK_OUT')}
              type="button"
            >
              Absen pulang <span aria-hidden="true">→</span>
            </button>
          </div>
          <span className="button-note" id="attendance-actions-note">
            Jika offline, antrean hanya tersimpan terenkripsi di perangkat dan belum menjadi receipt
            absensi.
          </span>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit art-orbit--one" />
          <div className="art-orbit art-orbit--two" />
          <div className="art-center" />
          <span className="art-spark art-spark--one">✳</span>
          <span className="art-spark art-spark--two">✦</span>
        </div>
      </section>

      {lastReceipt && (
        <section className="section-block" aria-label="Hasil absensi terakhir">
          <AttendanceReceiptNotice receipt={lastReceipt} />
        </section>
      )}

      {employeeId && queue ? (
        <EmployeeOfflineAttendanceQueue
          employeeId={employeeId}
          key={employeeId}
          onReceipt={setLastReceipt}
          queue={queue}
          refreshKey={queueRefreshKey}
          refreshSession={refreshSession}
        />
      ) : (
        <section className="section-block" aria-label="Antrean absensi offline">
          <p role="status">
            Antrean offline terkunci sampai profil karyawan dan penyimpanan terenkripsi dapat
            diverifikasi.
          </p>
        </section>
      )}

      <section className="section-block" aria-labelledby="today-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">RINGKASAN</span>
            <h2 id="today-title">Status hari ini</h2>
          </div>
        </div>
        <EmployeeTodaySummary />
      </section>

      <section className="shortcut-grid" aria-label="Menu karyawan">
        <Link className="shortcut-card" to="/employee/history">
          <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
            ▤
          </span>
          <span>
            <strong>Riwayat absensi</strong>
            <small>Riwayat pribadi</small>
          </span>
          <span className="shortcut-arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
        <Link className="shortcut-card" to="/employee/schedule">
          <span className="shortcut-icon shortcut-icon--mint" aria-hidden="true">
            ◷
          </span>
          <span>
            <strong>Jadwal kerja</strong>
            <small>Lihat jadwal yang ditetapkan</small>
          </span>
          <span className="shortcut-arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
        <Link className="shortcut-card" to="/employee/leave">
          <span className="shortcut-icon shortcut-icon--lilac" aria-hidden="true">
            ◌
          </span>
          <span>
            <strong>Cuti</strong>
            <small>Sisa cuti dan informasi cuti</small>
          </span>
          <span className="shortcut-arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
        <Link className="shortcut-card" to="/employee/requests">
          <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
            ▧
          </span>
          <span>
            <strong>Pengajuan saya</strong>
            <small>Izin, cuti, dan koreksi</small>
          </span>
          <span className="shortcut-arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
      </section>
    </>
  );
}

export function SupervisorDashboardResults({
  state,
  onRetry,
}: Readonly<{ state: AdminDashboardDataState; onRetry: () => void }>) {
  if (state.status === 'loading') return <LoadingState label="Memuat ringkasan tim…" />;
  if (state.status === 'error') {
    return (
      <ErrorState error={state.error} onRetry={onRetry} title="Ringkasan tim belum dapat dimuat" />
    );
  }

  return (
    <div className="dashboard-metric-grid dashboard-metric-grid--two" aria-busy={state.refreshing}>
      <article className="dashboard-empty-card">
        <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
          ✓
        </span>
        <div>
          <h3>Verifikasi absensi</h3>
          <p className="dashboard-summary-value">{state.dashboard.summary.waitingVerification}</p>
        </div>
      </article>
      <article className="dashboard-empty-card">
        <span className="shortcut-icon shortcut-icon--mint" aria-hidden="true">
          ▤
        </span>
        <div>
          <h3>Pengajuan tim</h3>
          <p className="dashboard-summary-value">{state.dashboard.summary.pendingRequests}</p>
        </div>
      </article>
    </div>
  );
}

export function SupervisorDashboardSummary() {
  const { state, refresh } = useAdminDashboard({});
  return <SupervisorDashboardResults onRetry={refresh} state={state} />;
}

function SupervisorHome() {
  return (
    <>
      <section className="welcome-panel welcome-panel--supervisor">
        <div className="welcome-copy">
          <span className="section-kicker">PUSAT KENDALI TOKO</span>
          <h2>
            Tim yang terjaga,
            <br />
            <em>operasional lancar.</em>
          </h2>
          <p>Pantau verifikasi dan pengajuan dari toko yang menjadi tanggung jawab Anda.</p>
        </div>
        <div className="welcome-badge" aria-hidden="true">
          <span>AJ</span>
          <small>
            BERSAMA
            <br />
            LEBIH BAIK
          </small>
        </div>
      </section>
      <section className="section-block" aria-labelledby="supervisor-pending-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">ANTREAN TIM</span>
            <h2 id="supervisor-pending-title">Perlu ditinjau</h2>
          </div>
        </div>
        <SupervisorDashboardSummary />
      </section>
      <section className="shortcut-grid" aria-label="Menu supervisor">
        <Link className="shortcut-card" to="/supervisor/verification">
          <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
            ✓
          </span>
          <span>
            <strong>Verifikasi absensi</strong>
            <small>Periksa catatan yang perlu ditinjau</small>
          </span>
          <span className="shortcut-arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
        <Link className="shortcut-card" to="/supervisor/requests">
          <span className="shortcut-icon shortcut-icon--mint" aria-hidden="true">
            ▤
          </span>
          <span>
            <strong>Pengajuan tim</strong>
            <small>Lihat permintaan karyawan</small>
          </span>
          <span className="shortcut-arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
      </section>
      <p className="quiet-note" role="note">
        Cakupan toko mengikuti penugasan yang diperiksa server. Tidak ada pemilih atau filter toko
        dari browser. Ringkasan hanya menampilkan jumlah verifikasi dan pengajuan tanpa detail
        karyawan.
      </p>
    </>
  );
}

function AdminHome() {
  return (
    <>
      <section className="welcome-panel welcome-panel--admin">
        <div className="welcome-copy">
          <span className="section-kicker">ADMINISTRASI KEHADIRAN</span>
          <h2>
            Gambaran jelas,
            <br />
            <em>keputusan tepat.</em>
          </h2>
          <p>
            Kelola data dasar dan pantau kehadiran. Ringkasan hanya akan tampil dari data server.
          </p>
        </div>
        <div className="admin-mark" aria-hidden="true">
          <span>AJ</span>
          <i>●</i>
          <i>●</i>
          <i>●</i>
        </div>
      </section>
      <section className="section-block" aria-labelledby="admin-summary-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">RINGKASAN SERVER</span>
            <h2 id="admin-summary-title">Status operasional</h2>
          </div>
        </div>
        <div className="dashboard-metric-grid">
          <EmptyDashboardMetric
            title="Ringkasan toko"
            description="Data toko belum tersedia dari layanan dashboard."
            icon="⌖"
          />
          <EmptyDashboardMetric
            title="Menunggu verifikasi atau keputusan"
            description="Jumlah pending belum tersedia dari layanan dashboard."
            icon="…"
          />
          <EmptyDashboardMetric
            title="Belum absen"
            description="Daftar belum absen belum tersedia; tidak ada status yang disimpulkan di browser."
            icon="—"
          />
        </div>
      </section>
      <section className="section-block" aria-labelledby="manage-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">MASTER DATA</span>
            <h2 id="manage-title">Kelola data dasar</h2>
          </div>
        </div>
        <div className="admin-grid">
          <Link className="admin-card" to="/admin/employees">
            <span className="shortcut-icon shortcut-icon--mint" aria-hidden="true">
              ♙
            </span>
            <strong>Karyawan</strong>
            <small>Profil dan akun</small>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
          <Link className="admin-card" to="/admin/stores">
            <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
              ⌖
            </span>
            <strong>Lokasi toko</strong>
            <small>Lokasi dan penugasan</small>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
          <Link className="admin-card" to="/admin/accounts">
            <span className="shortcut-icon shortcut-icon--lilac" aria-hidden="true">
              ◉
            </span>
            <strong>Akun pengguna</strong>
            <small>Akun dan akses</small>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
          <Link className="admin-card" to="/admin/schedules">
            <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
              ◷
            </span>
            <strong>Jadwal & shift</strong>
            <small>Pengaturan jadwal kerja</small>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
        </div>
      </section>
      <section className="section-block" aria-labelledby="admin-operations-title">
        <div className="section-heading">
          <div>
            <span className="section-kicker">OPERASIONAL</span>
            <h2 id="admin-operations-title">Pengawasan dan laporan</h2>
          </div>
        </div>
        <div className="shortcut-grid">
          <Link className="shortcut-card" to="/admin/requests">
            <span className="shortcut-icon shortcut-icon--mint" aria-hidden="true">
              ▤
            </span>
            <span>
              <strong>Pengajuan</strong>
              <small>Pengajuan untuk ditinjau</small>
            </span>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
          <Link className="shortcut-card" to="/admin/verification">
            <span className="shortcut-icon shortcut-icon--gold" aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>Verifikasi absensi</strong>
              <small>Absensi yang perlu ditinjau</small>
            </span>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
          <Link className="shortcut-card" to="/admin/reports">
            <span className="shortcut-icon shortcut-icon--lilac" aria-hidden="true">
              ▥
            </span>
            <span>
              <strong>Laporan</strong>
              <small>Rekap dan ekspor</small>
            </span>
            <span className="shortcut-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
        </div>
      </section>
    </>
  );
}

export function RoleHome({ role }: RoleHomeProps) {
  const location = useLocation();
  const route = getRoleRoute(location.pathname);
  if (route?.role === role && route.item.title) {
    return <FeaturePlaceholder title={route.item.title} />;
  }

  switch (role) {
    case 'ADMIN':
      return <AdminHome />;
    case 'SUPERVISOR':
      return <SupervisorHome />;
    case 'EMPLOYEE':
      return <EmployeeHome />;
  }
}
