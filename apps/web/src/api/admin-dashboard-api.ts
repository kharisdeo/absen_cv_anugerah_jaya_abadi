import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from './api-client.js';
import { API_DASHBOARD_STATUSES, type ApiDashboardStatus } from './api-contract.js';

export const DASHBOARD_STATUSES = API_DASHBOARD_STATUSES;

export type DashboardStatus = ApiDashboardStatus;

export type DashboardSummary = Readonly<{
  scheduledShifts: number;
  present: number;
  late: number;
  notCheckedIn: number;
  absent: number;
  leave: number;
  sick: number;
  annualLeave: number;
  waitingVerification: number;
  pendingRequests: number;
}>;

export type DashboardShiftItem = Readonly<{
  employeeId: string;
  employeeName: string;
  shiftAssignmentId: string;
  shiftId: string;
  shiftName: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  store: Readonly<{ id: string; name: string }> | null;
  date: string;
  status: DashboardStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  minutesAfterScheduledStart: number | null;
}>;

export type DashboardTrendItem = DashboardSummary & Readonly<{ date: string }>;

export type DashboardLateRankingItem = Readonly<{
  employeeId: string;
  employeeName: string;
  lateCount: number;
  lateDays: number;
  totalMinutesAfterScheduledStart: number;
}>;

export type DashboardPage<T> = Readonly<{
  items: readonly T[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export type AdminDashboard = Readonly<{
  summary: DashboardSummary;
  notCheckedIn: DashboardPage<DashboardShiftItem>;
  trend: readonly DashboardTrendItem[];
  lateRanking: readonly DashboardLateRankingItem[];
}>;

export type AdminDashboardQuery = Readonly<{
  date?: string;
  storeId?: string;
  shiftId?: string;
  page?: number;
  pageSize?: number;
}>;

export class AdminDashboardApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Dashboard belum dapat dimuat.',
    );
    this.name = 'AdminDashboardApiError';
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
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isDashboardCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const priorYear = year - 1;
  let ordinal = priorYear * 365 + Math.floor(priorYear / 4) - Math.floor(priorYear / 100);
  ordinal += Math.floor(priorYear / 400) + day;
  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) {
    ordinal += daysInMonth(year, currentMonth);
  }
  return ordinal;
}

function isClockTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 59;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (
    !match ||
    !isDashboardCalendarDate(match[1]) ||
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

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isDashboardStatus(value: unknown): value is DashboardStatus {
  return typeof value === 'string' && DASHBOARD_STATUSES.some((status) => status === value);
}

function invalidResponse(): AdminDashboardApiError {
  return new AdminDashboardApiError(502, 'INVALID_RESPONSE');
}

const SUMMARY_KEYS = [
  'scheduledShifts',
  'present',
  'late',
  'notCheckedIn',
  'absent',
  'leave',
  'sick',
  'annualLeave',
  'waitingVerification',
  'pendingRequests',
] as const;

function parseSummary(value: unknown): DashboardSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS)) throw invalidResponse();
  if (!SUMMARY_KEYS.every((key) => isCount(value[key]))) throw invalidResponse();
  return {
    scheduledShifts: value.scheduledShifts as number,
    present: value.present as number,
    late: value.late as number,
    notCheckedIn: value.notCheckedIn as number,
    absent: value.absent as number,
    leave: value.leave as number,
    sick: value.sick as number,
    annualLeave: value.annualLeave as number,
    waitingVerification: value.waitingVerification as number,
    pendingRequests: value.pendingRequests as number,
  };
}

function parseShiftItem(value: unknown): DashboardShiftItem {
  const keys = [
    'employeeId',
    'employeeName',
    'shiftAssignmentId',
    'shiftId',
    'shiftName',
    'scheduledStartTime',
    'scheduledEndTime',
    'store',
    'date',
    'status',
    'checkInAt',
    'checkOutAt',
    'minutesAfterScheduledStart',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw invalidResponse();
  const store = value.store;
  const validStore =
    store === null ||
    (isRecord(store) &&
      hasExactKeys(store, ['id', 'name']) &&
      isUuid(store.id) &&
      isNonEmptyString(store.name));
  const checkInAt = value.checkInAt;
  const checkOutAt = value.checkOutAt;
  const minutesAfterScheduledStart = value.minutesAfterScheduledStart;
  const validCheckIn = checkInAt === null || isInstant(checkInAt);
  const validCheckOut = checkOutAt === null || isInstant(checkOutAt);
  const validMinutes = minutesAfterScheduledStart === null || isNumber(minutesAfterScheduledStart);
  if (
    !isUuid(value.employeeId) ||
    !isNonEmptyString(value.employeeName) ||
    !isUuid(value.shiftAssignmentId) ||
    !isUuid(value.shiftId) ||
    !isNonEmptyString(value.shiftName) ||
    !isClockTime(value.scheduledStartTime) ||
    !isClockTime(value.scheduledEndTime) ||
    !validStore ||
    !isDashboardCalendarDate(value.date) ||
    !isDashboardStatus(value.status) ||
    !validCheckIn ||
    !validCheckOut ||
    !validMinutes
  ) {
    throw invalidResponse();
  }
  if (value.status !== 'ABSENT' && value.status !== 'NOT_CHECKED_IN') throw invalidResponse();
  return {
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    shiftAssignmentId: value.shiftAssignmentId,
    shiftId: value.shiftId,
    shiftName: value.shiftName,
    scheduledStartTime: value.scheduledStartTime,
    scheduledEndTime: value.scheduledEndTime,
    store: store === null ? null : { id: store.id as string, name: store.name as string },
    date: value.date,
    status: value.status,
    checkInAt: checkInAt === null ? null : (checkInAt as string),
    checkOutAt: checkOutAt === null ? null : (checkOutAt as string),
    minutesAfterScheduledStart:
      minutesAfterScheduledStart === null ? null : (minutesAfterScheduledStart as number),
  };
}

function parseTrendItem(value: unknown): DashboardTrendItem {
  if (!isRecord(value) || !hasExactKeys(value, ['date', ...SUMMARY_KEYS])) throw invalidResponse();
  if (!isDashboardCalendarDate(value.date)) throw invalidResponse();
  const summary = parseSummary(Object.fromEntries(SUMMARY_KEYS.map((key) => [key, value[key]])));
  return { date: value.date, ...summary };
}

function parseRankingItem(value: unknown): DashboardLateRankingItem {
  const keys = [
    'employeeId',
    'employeeName',
    'lateCount',
    'lateDays',
    'totalMinutesAfterScheduledStart',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !isUuid(value.employeeId) ||
    !isNonEmptyString(value.employeeName) ||
    !isCount(value.lateCount) ||
    !isCount(value.lateDays) ||
    value.lateDays > value.lateCount ||
    !isNumber(value.totalMinutesAfterScheduledStart)
  ) {
    throw invalidResponse();
  }
  return {
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    lateCount: value.lateCount,
    lateDays: value.lateDays,
    totalMinutesAfterScheduledStart: value.totalMinutesAfterScheduledStart,
  };
}

function parseDashboardPage(value: unknown): DashboardPage<DashboardShiftItem> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'page', 'pageSize', 'hasNextPage']) ||
    !Array.isArray(value.items) ||
    !isCount(value.page) ||
    value.page < 1 ||
    !isCount(value.pageSize) ||
    value.pageSize < 1 ||
    value.pageSize > 50 ||
    typeof value.hasNextPage !== 'boolean' ||
    value.items.length > value.pageSize
  ) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseShiftItem),
    page: value.page,
    pageSize: value.pageSize,
    hasNextPage: value.hasNextPage,
  };
}

function parseDashboard(value: unknown, query: AdminDashboardQuery): AdminDashboard {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['summary', 'notCheckedIn', 'trend', 'lateRanking']) ||
    !Array.isArray(value.trend) ||
    value.trend.length !== 30 ||
    !Array.isArray(value.lateRanking) ||
    value.lateRanking.length > 10
  ) {
    throw invalidResponse();
  }
  const notCheckedIn = parseDashboardPage(value.notCheckedIn);
  if (notCheckedIn.page !== (query.page ?? 1) || notCheckedIn.pageSize !== (query.pageSize ?? 25)) {
    throw invalidResponse();
  }
  const trend = value.trend.map(parseTrendItem);
  const firstOrdinal = dateOrdinal(trend[0]!.date);
  const lastOrdinal = dateOrdinal(trend[29]!.date);
  if (
    lastOrdinal - firstOrdinal !== 29 ||
    trend.some((item, index) => dateOrdinal(item.date) !== firstOrdinal + index) ||
    (query.date !== undefined && query.date !== '' && trend[29]!.date !== query.date)
  ) {
    throw invalidResponse();
  }
  return {
    summary: parseSummary(value.summary),
    notCheckedIn,
    trend,
    lateRanking: value.lateRanking.map(parseRankingItem),
  };
}

function buildQuery(query: AdminDashboardQuery): string {
  if (!isRecord(query)) throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  const allowedKeys = new Set(['date', 'storeId', 'shiftId', 'page', 'pageSize']);
  if (Object.keys(query).some((key) => !allowedKeys.has(key))) {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  const params = new URLSearchParams();
  const date = query.date;
  const storeId = query.storeId;
  const shiftId = query.shiftId;
  const requestedPage = query.page;
  const requestedPageSize = query.pageSize;
  if (date !== undefined && typeof date !== 'string') {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  if (storeId !== undefined && typeof storeId !== 'string') {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  if (shiftId !== undefined && typeof shiftId !== 'string') {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  if (date) {
    if (!isDashboardCalendarDate(date))
      throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
    params.set('date', date);
  }
  if (storeId) {
    if (!isUuid(storeId)) throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
    params.set('storeId', storeId);
  }
  if (shiftId) {
    if (!isUuid(shiftId)) throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
    params.set('shiftId', shiftId);
  }
  if (requestedPage !== undefined && typeof requestedPage !== 'number') {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  if (requestedPageSize !== undefined && typeof requestedPageSize !== 'number') {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  const page = requestedPage ?? 1;
  const pageSize = requestedPageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new AdminDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
  }
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export const adminDashboardApi = {
  async getDashboard(
    query: AdminDashboardQuery = {},
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<AdminDashboard> {
    const response = await apiFetch(`${API_BASE_URL}/dashboard${buildQuery(query)}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload = await readApiJson(
      response,
      200,
      ({ status, code, requestId }) => new AdminDashboardApiError(status, code, requestId),
    );
    return parseDashboard(payload, query);
  },
};
