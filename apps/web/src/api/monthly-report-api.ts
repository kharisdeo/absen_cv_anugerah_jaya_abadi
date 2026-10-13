import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiErrorDetails, readApiJson } from './api-client.js';

export const MONTHLY_REPORT_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MONTHLY_REPORT_MAX_SHIFT_DAYS = 25_000;

export const MONTHLY_REPORT_STATUSES = [
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
  'NOT_STARTED',
] as const;

export const ATTENDANCE_VALIDATION_STATUSES = [
  'VALID',
  'APPROVED',
  'PENDING_VERIFICATION',
  'PENDING_OFFLINE',
  'REJECTED',
] as const;

export type MonthlyReportStatus = (typeof MONTHLY_REPORT_STATUSES)[number];
export type AttendanceValidationStatus = (typeof ATTENDANCE_VALIDATION_STATUSES)[number];
export type MonthlyReportQuery = Readonly<{
  month: string;
  storeId?: string;
  employeeId?: string;
}>;

export type MonthlyReportSummary = Readonly<{
  employeeId: string;
  employeeName: string;
  workDays: number;
  present: number;
  lateCount: number;
  lateMinutes: number;
  absent: number;
  leave: number;
  sick: number;
  annualLeave: number;
  totalWorkMinutes: number;
  approvedOvertimeMinutes: number;
}>;

export type DailyReportDetail = Readonly<{
  employeeId: string;
  employeeName: string;
  date: string;
  store: Readonly<{ id: string; name: string }> | null;
  shift: Readonly<{ assignmentId: string; id: string; name: string }>;
  checkInAt: string | null;
  checkOutAt: string | null;
  durationMinutes: number | null;
  lateMinutesAfterScheduledStart: number | null;
  status: MonthlyReportStatus;
  checkInValidationStatus: AttendanceValidationStatus | null;
  checkOutValidationStatus: AttendanceValidationStatus | null;
  validationStatus: AttendanceValidationStatus | 'MIXED' | null;
}>;

export type MonthlyReport = Readonly<{
  month: string;
  filters: Readonly<{ storeId: string | null; employeeId: string | null }>;
  definitions: Readonly<{
    workDays: 'scheduled_employee_work_dates_excluding_holidays';
    workMinutes: 'valid_approved_pair_rounded_to_nearest_minute_less_shift_break';
    lateMinutes: 'rounded_minutes_after_scheduled_start_including_tolerance';
    overtime: 'approved_admin_requests_unique_store_when_store_scoped';
  }>;
  summary: readonly MonthlyReportSummary[];
  dailyDetails: readonly DailyReportDetail[];
}>;

export class MonthlyReportApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Laporan bulanan belum dapat dimuat.',
    );
    this.name = 'MonthlyReportApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isMonthlyReportMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 1 && year <= 9999;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (
    !match ||
    !isCalendarDate(match[1]) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) {
    return false;
  }
  if (match[5] === 'Z') return true;
  const offsetHour = Number(match[7]);
  const offsetMinute = Number(match[8]);
  return offsetHour <= 14 && offsetMinute <= 59 && (offsetHour < 14 || offsetMinute === 0);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isReportStatus(value: unknown): value is MonthlyReportStatus {
  return (
    typeof value === 'string' && MONTHLY_REPORT_STATUSES.includes(value as MonthlyReportStatus)
  );
}

function isValidationStatus(value: unknown): value is AttendanceValidationStatus {
  return (
    typeof value === 'string' &&
    ATTENDANCE_VALIDATION_STATUSES.includes(value as AttendanceValidationStatus)
  );
}

function invalidResponse(): MonthlyReportApiError {
  return new MonthlyReportApiError(502, 'INVALID_RESPONSE');
}

function parseQuery(query: MonthlyReportQuery): URLSearchParams {
  if (
    !isRecord(query) ||
    Object.keys(query).some((key) => !['month', 'storeId', 'employeeId'].includes(key)) ||
    !isMonthlyReportMonth(query.month) ||
    (query.storeId !== undefined && !isUuid(query.storeId)) ||
    (query.employeeId !== undefined && !isUuid(query.employeeId))
  ) {
    throw new MonthlyReportApiError(400, 'INVALID_REPORT_INPUT');
  }
  const params = new URLSearchParams({ month: query.month });
  if (query.storeId) params.set('storeId', query.storeId);
  if (query.employeeId) params.set('employeeId', query.employeeId);
  return params;
}

function parseSummary(value: unknown): MonthlyReportSummary {
  const keys = [
    'employeeId',
    'employeeName',
    'workDays',
    'present',
    'lateCount',
    'lateMinutes',
    'absent',
    'leave',
    'sick',
    'annualLeave',
    'totalWorkMinutes',
    'approvedOvertimeMinutes',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !isUuid(value.employeeId) ||
    !isNonEmptyString(value.employeeName) ||
    !keys.slice(2).every((key) => isCount(value[key]))
  ) {
    throw invalidResponse();
  }
  return value as MonthlyReportSummary;
}

function parseStore(value: unknown): DailyReportDetail['store'] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'name']) ||
    !isUuid(value.id) ||
    !isNonEmptyString(value.name)
  ) {
    throw invalidResponse();
  }
  return { id: value.id, name: value.name };
}

function parseDetail(value: unknown, month: string): DailyReportDetail {
  const keys = [
    'employeeId',
    'employeeName',
    'date',
    'store',
    'shift',
    'checkInAt',
    'checkOutAt',
    'durationMinutes',
    'lateMinutesAfterScheduledStart',
    'status',
    'checkInValidationStatus',
    'checkOutValidationStatus',
    'validationStatus',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw invalidResponse();
  const shift = value.shift;
  const checkInAt = value.checkInAt;
  const checkOutAt = value.checkOutAt;
  const durationMinutes = value.durationMinutes;
  const lateMinutes = value.lateMinutesAfterScheduledStart;
  const checkInStatus = value.checkInValidationStatus;
  const checkOutStatus = value.checkOutValidationStatus;
  const validationStatus = value.validationStatus;
  if (
    !isUuid(value.employeeId) ||
    !isNonEmptyString(value.employeeName) ||
    !isCalendarDate(value.date) ||
    !value.date.startsWith(`${month}-`) ||
    !isRecord(shift) ||
    !hasExactKeys(shift, ['assignmentId', 'id', 'name']) ||
    !isUuid(shift.assignmentId) ||
    !isUuid(shift.id) ||
    !isNonEmptyString(shift.name) ||
    !(checkInAt === null || isInstant(checkInAt)) ||
    !(checkOutAt === null || isInstant(checkOutAt)) ||
    !(durationMinutes === null || isCount(durationMinutes)) ||
    !(lateMinutes === null || isCount(lateMinutes)) ||
    !isReportStatus(value.status) ||
    !(checkInStatus === null || isValidationStatus(checkInStatus)) ||
    !(checkOutStatus === null || isValidationStatus(checkOutStatus)) ||
    !(
      validationStatus === null ||
      validationStatus === 'MIXED' ||
      isValidationStatus(validationStatus)
    )
  ) {
    throw invalidResponse();
  }
  return {
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    date: value.date,
    store: parseStore(value.store),
    shift: { assignmentId: shift.assignmentId, id: shift.id, name: shift.name },
    checkInAt,
    checkOutAt,
    durationMinutes,
    lateMinutesAfterScheduledStart: lateMinutes,
    status: value.status,
    checkInValidationStatus: checkInStatus,
    checkOutValidationStatus: checkOutStatus,
    validationStatus,
  };
}

function parseMonthlyReport(value: unknown, query: MonthlyReportQuery): MonthlyReport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['month', 'filters', 'definitions', 'summary', 'dailyDetails']) ||
    value.month !== query.month ||
    !isRecord(value.filters) ||
    !hasExactKeys(value.filters, ['storeId', 'employeeId']) ||
    value.filters.storeId !== (query.storeId ?? null) ||
    value.filters.employeeId !== (query.employeeId ?? null) ||
    !isRecord(value.definitions) ||
    !hasExactKeys(value.definitions, ['workDays', 'workMinutes', 'lateMinutes', 'overtime']) ||
    value.definitions.workDays !== 'scheduled_employee_work_dates_excluding_holidays' ||
    value.definitions.workMinutes !==
      'valid_approved_pair_rounded_to_nearest_minute_less_shift_break' ||
    value.definitions.lateMinutes !== 'rounded_minutes_after_scheduled_start_including_tolerance' ||
    value.definitions.overtime !== 'approved_admin_requests_unique_store_when_store_scoped' ||
    !Array.isArray(value.summary) ||
    !Array.isArray(value.dailyDetails) ||
    value.dailyDetails.length > MONTHLY_REPORT_MAX_SHIFT_DAYS
  ) {
    throw invalidResponse();
  }
  const summary = value.summary.map(parseSummary);
  const dailyDetails = value.dailyDetails.map((item) => parseDetail(item, query.month));
  const employeeNames = new Map(summary.map((row) => [row.employeeId, row.employeeName]));
  if (
    new Set(summary.map((row) => row.employeeId)).size !== summary.length ||
    (query.employeeId !== undefined &&
      summary.some((row) => row.employeeId !== query.employeeId)) ||
    dailyDetails.some((row) => employeeNames.get(row.employeeId) !== row.employeeName)
  ) {
    throw invalidResponse();
  }
  return {
    month: value.month,
    filters: {
      storeId: value.filters.storeId as string | null,
      employeeId: value.filters.employeeId as string | null,
    },
    definitions: {
      workDays: value.definitions.workDays,
      workMinutes: value.definitions.workMinutes,
      lateMinutes: value.definitions.lateMinutes,
      overtime: value.definitions.overtime,
    },
    summary,
    dailyDetails,
  };
}

function monthlyReportUrl(query: MonthlyReportQuery, exportFile = false): string {
  const suffix = exportFile ? '/export' : '';
  return `${API_BASE_URL}/reports/monthly${suffix}?${parseQuery(query).toString()}`;
}

export const monthlyReportApi = {
  async getMonthlyReport(
    query: MonthlyReportQuery,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<MonthlyReport> {
    const response = await apiFetch(monthlyReportUrl(query), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload = await readApiJson(
      response,
      200,
      ({ status, code, requestId }) => new MonthlyReportApiError(status, code, requestId),
    );
    return parseMonthlyReport(payload, query);
  },

  async exportMonthlyReport(
    query: MonthlyReportQuery,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Blob> {
    const response = await apiFetch(monthlyReportUrl(query, true), {
      method: 'GET',
      headers: { Accept: MONTHLY_REPORT_XLSX_MIME },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      const details = await readApiErrorDetails(response);
      throw new MonthlyReportApiError(details.status, details.code, details.requestId);
    }
    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
        MONTHLY_REPORT_XLSX_MIME
    ) {
      throw invalidResponse();
    }
    const blob = await response.blob();
    if (blob.size < 4) throw invalidResponse();
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (
      signature[0] !== 0x50 ||
      signature[1] !== 0x4b ||
      signature[2] !== 0x03 ||
      signature[3] !== 0x04
    ) {
      throw invalidResponse();
    }
    return blob;
  },
};
