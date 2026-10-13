import { USER_ROLES, type UserRole } from '../auth/session.js';

export type RoleNavigationItem = Readonly<{
  to: string;
  label: string;
  icon: string;
  title: string | null;
  end?: boolean;
}>;

export const ROLE_BASE_PATHS: Readonly<Record<UserRole, string>> = {
  EMPLOYEE: '/employee',
  SUPERVISOR: '/supervisor',
  ADMIN: '/admin',
};

/** One source of truth for role menus and the routes protected by each role guard. */
export const ROLE_NAVIGATION: Readonly<Record<UserRole, readonly RoleNavigationItem[]>> = {
  EMPLOYEE: [
    { to: '/employee', label: 'Ringkasan', icon: '01', title: null, end: true },
    { to: '/employee/history', label: 'Riwayat absensi', icon: '02', title: 'Riwayat absensi' },
    { to: '/employee/schedule', label: 'Jadwal kerja', icon: '03', title: 'Jadwal kerja' },
    { to: '/employee/leave', label: 'Cuti', icon: '04', title: 'Cuti' },
    { to: '/employee/requests', label: 'Pengajuan saya', icon: '05', title: 'Pengajuan saya' },
    { to: '/employee/notifications', label: 'Notifikasi', icon: '06', title: 'Notifikasi' },
  ],
  SUPERVISOR: [
    { to: '/supervisor', label: 'Ringkasan', icon: '01', title: null, end: true },
    {
      to: '/supervisor/verification',
      label: 'Verifikasi absensi',
      icon: '02',
      title: 'Verifikasi absensi',
    },
    { to: '/supervisor/requests', label: 'Pengajuan tim', icon: '03', title: 'Pengajuan tim' },
    { to: '/supervisor/notifications', label: 'Notifikasi', icon: '04', title: 'Notifikasi' },
    { to: '/supervisor/reports', label: 'Laporan', icon: '05', title: 'Laporan kehadiran' },
  ],
  ADMIN: [
    { to: '/admin', label: 'Ringkasan', icon: '01', title: null, end: true },
    { to: '/admin/employees', label: 'Karyawan', icon: '02', title: 'Data karyawan' },
    { to: '/admin/stores', label: 'Lokasi toko', icon: '03', title: 'Lokasi toko' },
    { to: '/admin/accounts', label: 'Akun pengguna', icon: '04', title: 'Akun pengguna' },
    { to: '/admin/schedules', label: 'Jadwal & shift', icon: '05', title: 'Jadwal dan shift' },
    { to: '/admin/requests', label: 'Pengajuan', icon: '06', title: 'Pengajuan' },
    {
      to: '/admin/verification',
      label: 'Verifikasi absensi',
      icon: '07',
      title: 'Verifikasi absensi',
    },
    { to: '/admin/reports', label: 'Laporan', icon: '08', title: 'Laporan kehadiran' },
    { to: '/admin/notifications', label: 'Notifikasi', icon: '09', title: 'Notifikasi' },
    {
      to: '/admin/system-disruptions',
      label: 'Gangguan sistem',
      icon: '10',
      title: 'Gangguan sistem',
    },
    { to: '/admin/audit-logs', label: 'Audit log', icon: '11', title: 'Audit log' },
  ],
};

export function getRoleRoute(pathname: string): Readonly<{
  role: UserRole;
  item: RoleNavigationItem;
}> | null {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';

  for (const role of USER_ROLES) {
    const item = ROLE_NAVIGATION[role].find((route) => route.to === normalizedPath);
    if (item) return { role, item };
  }

  return null;
}
