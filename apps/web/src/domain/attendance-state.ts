import {
  API_ATTENDANCE_VALIDATION_STATUSES,
  API_REQUEST_STATUSES,
  type ApiAttendanceValidationStatus,
  type ApiRequestStatus,
} from '../api/api-contract.js';

export const ATTENDANCE_VALIDATION_STATUSES = API_ATTENDANCE_VALIDATION_STATUSES;

export type AttendanceValidationStatus = ApiAttendanceValidationStatus;

export const DAILY_ATTENDANCE_STATUSES = [
  'PRESENT',
  'LATE',
  'EARLY_LEAVE',
  'MISSING_CHECKOUT',
  'WAITING_VERIFICATION',
  'LEAVE',
  'SICK',
  'ANNUAL_LEAVE',
  'HOLIDAY',
  'ABSENT',
] as const;

export type DailyAttendanceStatus = (typeof DAILY_ATTENDANCE_STATUSES)[number];

export const REQUEST_STATUSES = API_REQUEST_STATUSES;

export type RequestStatus = ApiRequestStatus;

export type StatusTone = 'positive' | 'warning' | 'negative' | 'neutral' | 'pending';
export type StatusPresentation = Readonly<{ label: string; tone: StatusTone }>;

const attendanceValidationPresentation: Readonly<
  Record<AttendanceValidationStatus, StatusPresentation>
> = {
  VALID: { label: 'Valid', tone: 'positive' },
  PENDING_VERIFICATION: { label: 'Perlu verifikasi', tone: 'warning' },
  APPROVED: { label: 'Disetujui admin', tone: 'positive' },
  REJECTED: { label: 'Ditolak', tone: 'negative' },
  PENDING_OFFLINE: { label: 'Absen tertunda', tone: 'pending' },
};

const dailyAttendancePresentation: Readonly<Record<DailyAttendanceStatus, StatusPresentation>> = {
  PRESENT: { label: 'Hadir', tone: 'positive' },
  LATE: { label: 'Terlambat', tone: 'warning' },
  EARLY_LEAVE: { label: 'Pulang lebih awal', tone: 'warning' },
  MISSING_CHECKOUT: { label: 'Belum absen pulang', tone: 'warning' },
  WAITING_VERIFICATION: { label: 'Menunggu verifikasi', tone: 'warning' },
  LEAVE: { label: 'Izin', tone: 'neutral' },
  SICK: { label: 'Sakit', tone: 'neutral' },
  ANNUAL_LEAVE: { label: 'Cuti', tone: 'neutral' },
  HOLIDAY: { label: 'Hari libur', tone: 'neutral' },
  ABSENT: { label: 'Tidak hadir', tone: 'negative' },
};

const requestPresentation: Readonly<Record<RequestStatus, StatusPresentation>> = {
  PENDING: { label: 'Menunggu keputusan', tone: 'warning' },
  APPROVED: { label: 'Disetujui', tone: 'positive' },
  REJECTED: { label: 'Ditolak', tone: 'negative' },
  CANCELLED: { label: 'Dibatalkan', tone: 'neutral' },
};

const attendanceValidationTransitions: Readonly<
  Partial<Record<AttendanceValidationStatus, readonly AttendanceValidationStatus[]>>
> = {
  PENDING_OFFLINE: ['VALID', 'PENDING_VERIFICATION'],
  PENDING_VERIFICATION: ['APPROVED', 'REJECTED'],
};

const requestTransitions: Readonly<Partial<Record<RequestStatus, readonly RequestStatus[]>>> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
};

export function getAttendanceValidationPresentation(
  status: AttendanceValidationStatus,
): StatusPresentation {
  return attendanceValidationPresentation[status];
}

export function getDailyAttendancePresentation(status: DailyAttendanceStatus): StatusPresentation {
  return dailyAttendancePresentation[status];
}

export function getRequestPresentation(status: RequestStatus): StatusPresentation {
  return requestPresentation[status];
}

export function canTransitionAttendanceValidation(
  from: AttendanceValidationStatus,
  to: AttendanceValidationStatus,
): boolean {
  return attendanceValidationTransitions[from]?.includes(to) ?? false;
}

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return requestTransitions[from]?.includes(to) ?? false;
}
