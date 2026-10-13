import type { MonthlyReportStatus } from '../api/monthly-report-api.js';

export const MONTHLY_REPORT_STATUS_LABELS: Readonly<Record<MonthlyReportStatus, string>> = {
  PRESENT: 'Hadir',
  LATE: 'Terlambat',
  NOT_CHECKED_IN: 'Belum check-in',
  ABSENT: 'Tidak hadir',
  LEAVE: 'Izin',
  SICK: 'Sakit',
  ANNUAL_LEAVE: 'Cuti tahunan',
  WAITING_VERIFICATION: 'Menunggu verifikasi',
  REQUEST_PENDING: 'Pengajuan menunggu',
  HOLIDAY: 'Hari libur',
  EARLY_LEAVE: 'Pulang lebih awal',
  MISSING_CHECKOUT: 'Belum check-out',
  UNATTRIBUTED_ATTENDANCE: 'Absensi tanpa jadwal',
  NOT_STARTED: 'Belum dimulai',
};

export function currentJakartaMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Tanggal WIB tidak dapat ditentukan.');
  return `${year}-${month}`;
}

export function formatReportDate(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

export function formatReportInstant(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function formatReportMinutes(value: number | null): string {
  if (value === null) return '—';
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  if (hours === 0) return `${minutes} mnt`;
  if (minutes === 0) return `${hours} jam`;
  return `${hours} jam ${minutes} mnt`;
}

export function formatReportCount(value: number): string {
  return new Intl.NumberFormat('id-ID').format(value);
}
