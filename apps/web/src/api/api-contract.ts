/** Shared enum/date primitives mirrored from docs/openapi.yaml (OpenAPI 3.1). */
export const API_ATTENDANCE_TYPES = ['CHECK_IN', 'CHECK_OUT'] as const;
export type ApiAttendanceType = (typeof API_ATTENDANCE_TYPES)[number];

export const API_ATTENDANCE_ATTEMPT_STATES = ['RECEIVED', 'RECORDED'] as const;
export type ApiAttendanceAttemptState = (typeof API_ATTENDANCE_ATTEMPT_STATES)[number];

export const API_ATTENDANCE_VALIDATION_STATUSES = [
  'VALID',
  'PENDING_VERIFICATION',
  'APPROVED',
  'REJECTED',
  'PENDING_OFFLINE',
] as const;
export type ApiAttendanceValidationStatus = (typeof API_ATTENDANCE_VALIDATION_STATUSES)[number];

export const API_ATTENDANCE_VALIDATION_METHODS = [
  'GPS',
  'QR',
  'WIFI',
  'SUPERVISOR',
  'OFFLINE',
  'ASSISTED',
] as const;
export type ApiAttendanceValidationMethod = (typeof API_ATTENDANCE_VALIDATION_METHODS)[number];

export const API_NETWORK_STATUSES = ['ONLINE', 'OFFLINE'] as const;
export type ApiNetworkStatus = (typeof API_NETWORK_STATUSES)[number];

export const API_ATTENDANCE_LOCATION_FAILURE_REASONS = [
  'PERMISSION_DENIED',
  'POSITION_UNAVAILABLE',
  'TIMEOUT',
] as const;
export type ApiAttendanceLocationFailureReason =
  (typeof API_ATTENDANCE_LOCATION_FAILURE_REASONS)[number];

export const API_REQUEST_TYPES = ['LEAVE', 'SICK', 'ANNUAL_LEAVE', 'OVERTIME'] as const;
export type ApiRequestType = (typeof API_REQUEST_TYPES)[number];

export const API_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApiRequestStatus = (typeof API_REQUEST_STATUSES)[number];

export const API_ACCOUNT_ROLES = ['ADMIN', 'SUPERVISOR', 'EMPLOYEE'] as const;
export type ApiAccountRole = (typeof API_ACCOUNT_ROLES)[number];

export const API_ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export type ApiAccountStatus = (typeof API_ACCOUNT_STATUSES)[number];

export const API_EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ApiEmployeeStatus = (typeof API_EMPLOYEE_STATUSES)[number];

export const API_DEVICE_BINDING_STATUSES = ['PENDING', 'APPROVED', 'REVOKED'] as const;
export type ApiDeviceBindingStatus = (typeof API_DEVICE_BINDING_STATUSES)[number];

export const API_DASHBOARD_STATUSES = [
  'PRESENT',
  'LATE',
  'NOT_CHECKED_IN',
  'ABSENT',
  'LEAVE',
  'SICK',
  'ANNUAL_LEAVE',
  'WAITING_VERIFICATION',
  'REQUEST_PENDING',
  'HOLIDAY',
  'EARLY_LEAVE',
  'MISSING_CHECKOUT',
  'UNATTRIBUTED_ATTENDANCE',
] as const;
export type ApiDashboardStatus = (typeof API_DASHBOARD_STATUSES)[number];

export type ApiDateTime = string;
export type ApiCalendarDate = string;

const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

export function isApiCalendarDate(value: unknown): value is ApiCalendarDate {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

/** OpenAPI date-time is an instant and must include Z or an explicit numeric offset. */
export function isApiDateTime(value: unknown): value is ApiDateTime {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match || !isApiCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[8]);
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[9]);
  return offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

/** Serialize instants as canonical UTC ISO-8601; civil dates remain YYYY-MM-DD strings. */
export function serializeApiDateTime(value: Date): ApiDateTime {
  if (!Number.isFinite(value.getTime())) throw new RangeError('Waktu API tidak valid.');
  return value.toISOString();
}
