import { API_BASE_URL } from '../config.js';
import type { AttendanceValidationStatus } from '../domain/attendance-state.js';
import { ApiClientError, apiFetch, readApiJson, type ApiFetchOptions } from './api-client.js';
import {
  API_ATTENDANCE_VALIDATION_STATUSES,
  API_DASHBOARD_STATUSES,
  API_REQUEST_STATUSES,
  API_REQUEST_TYPES,
  isApiCalendarDate,
  isApiDateTime,
} from './api-contract.js';

export const EMPLOYEE_DASHBOARD_STATUSES = API_DASHBOARD_STATUSES;

export type EmployeeDashboardStatus = (typeof EMPLOYEE_DASHBOARD_STATUSES)[number];

export type EmployeeDashboardQuery = Readonly<{
  historyPage?: number;
  historyPageSize?: number;
  historyFrom?: string;
  historyTo?: string;
  requestPage?: number;
  requestPageSize?: number;
}>;

export type EmployeeDashboardTodayItem = Readonly<{
  employeeId: string;
  employeeName: string;
  shiftAssignmentId: string;
  shiftId: string;
  shiftName: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  store: Readonly<{ id: string; name: string }> | null;
  date: string;
  status: EmployeeDashboardStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  minutesAfterScheduledStart: number | null;
}>;

export type EmployeeHistoryItem = Readonly<{
  id: string;
  date: string;
  type: 'CHECK_IN' | 'CHECK_OUT';
  serverTime: string;
  validationStatus: AttendanceValidationStatus;
  store: Readonly<{ id: string; name: string }> | null;
  shift: Readonly<{ id: string; name: string }> | null;
}>;

export type EmployeeRequestStatusItem = Readonly<{
  id: string;
  requestType: 'LEAVE' | 'SICK' | 'ANNUAL_LEAVE' | 'OVERTIME' | 'CORRECTION';
  startDate: string;
  endDate: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedAt: string;
  decisionAt: string | null;
}>;

export type EmployeeDashboardPage<Item> = Readonly<{
  items: readonly Item[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export type EmployeeDashboard = Readonly<{
  today: readonly EmployeeDashboardTodayItem[];
  history: EmployeeDashboardPage<EmployeeHistoryItem>;
  requests: EmployeeDashboardPage<EmployeeRequestStatusItem>;
}>;

export class EmployeeDashboardApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Data absensi pribadi belum berhasil dimuat.',
    );
    this.name = 'EmployeeDashboardApiError';
  }
}

export type EmployeeDashboardApiOptions = Readonly<{
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}>;

const QUERY_KEYS = [
  'historyPage',
  'historyPageSize',
  'historyFrom',
  'historyTo',
  'requestPage',
  'requestPageSize',
] as const;
const DASHBOARD_KEYS = ['today', 'history', 'requests'] as const;
const TODAY_KEYS = [
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
const HISTORY_KEYS = [
  'id',
  'date',
  'type',
  'serverTime',
  'validationStatus',
  'store',
  'shift',
] as const;
const REQUEST_KEYS = [
  'id',
  'requestType',
  'startDate',
  'endDate',
  'status',
  'requestedAt',
  'decisionAt',
] as const;
const PAGE_KEYS = ['items', 'page', 'pageSize', 'hasNextPage'] as const;
const VALIDATION_STATUSES: readonly string[] = API_ATTENDANCE_VALIDATION_STATUSES;
const REQUEST_TYPES: readonly string[] = API_REQUEST_TYPES;
const REQUEST_STATUSES: readonly string[] = API_REQUEST_STATUSES;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => (keys as readonly string[]).includes(key));
}

export function isCalendarDate(value: unknown): value is string {
  return isApiCalendarDate(value);
}

function isIsoInstant(value: unknown): value is string {
  return isApiDateTime(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function invalidInput(): EmployeeDashboardApiError {
  return new EmployeeDashboardApiError(400, 'INVALID_DASHBOARD_INPUT');
}

function invalidResponse(): EmployeeDashboardApiError {
  return new EmployeeDashboardApiError(502, 'INVALID_RESPONSE');
}

function validatePage(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10_000;
}

function validatePageSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 50;
}

function validateQuery(value: EmployeeDashboardQuery): void {
  if (!isRecord(value) || !hasOnlyKeys(value, QUERY_KEYS)) throw invalidInput();
  if (
    (value.historyPage !== undefined && !validatePage(value.historyPage)) ||
    (value.requestPage !== undefined && !validatePage(value.requestPage)) ||
    (value.historyPageSize !== undefined && !validatePageSize(value.historyPageSize)) ||
    (value.requestPageSize !== undefined && !validatePageSize(value.requestPageSize)) ||
    (value.historyFrom !== undefined && !isCalendarDate(value.historyFrom)) ||
    (value.historyTo !== undefined && !isCalendarDate(value.historyTo)) ||
    (value.historyFrom !== undefined &&
      value.historyTo !== undefined &&
      value.historyFrom > value.historyTo)
  ) {
    throw invalidInput();
  }
}

function parseStore(value: unknown): EmployeeDashboardTodayItem['store'] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'name']) ||
    !isUuid(value.id) ||
    typeof value.name !== 'string'
  ) {
    throw invalidResponse();
  }
  return { id: value.id, name: value.name };
}

function parseTodayItem(value: unknown): EmployeeDashboardTodayItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, TODAY_KEYS) ||
    !isUuid(value.employeeId) ||
    typeof value.employeeName !== 'string' ||
    !isUuid(value.shiftAssignmentId) ||
    !isUuid(value.shiftId) ||
    typeof value.shiftName !== 'string' ||
    typeof value.scheduledStartTime !== 'string' ||
    !TIME_PATTERN.test(value.scheduledStartTime) ||
    typeof value.scheduledEndTime !== 'string' ||
    !TIME_PATTERN.test(value.scheduledEndTime) ||
    !isCalendarDate(value.date) ||
    !(EMPLOYEE_DASHBOARD_STATUSES as readonly string[]).includes(String(value.status)) ||
    !(value.checkInAt === null || isIsoInstant(value.checkInAt)) ||
    !(value.checkOutAt === null || isIsoInstant(value.checkOutAt)) ||
    !(
      value.minutesAfterScheduledStart === null ||
      (typeof value.minutesAfterScheduledStart === 'number' &&
        Number.isFinite(value.minutesAfterScheduledStart) &&
        value.minutesAfterScheduledStart >= 0)
    )
  ) {
    throw invalidResponse();
  }
  return {
    employeeId: value.employeeId,
    employeeName: value.employeeName,
    shiftAssignmentId: value.shiftAssignmentId,
    shiftId: value.shiftId,
    shiftName: value.shiftName,
    scheduledStartTime: value.scheduledStartTime,
    scheduledEndTime: value.scheduledEndTime,
    store: parseStore(value.store),
    date: value.date,
    status: value.status as EmployeeDashboardStatus,
    checkInAt: value.checkInAt,
    checkOutAt: value.checkOutAt,
    minutesAfterScheduledStart: value.minutesAfterScheduledStart,
  };
}

function parseHistoryItem(value: unknown): EmployeeHistoryItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, HISTORY_KEYS) ||
    !isUuid(value.id) ||
    !isCalendarDate(value.date) ||
    (value.type !== 'CHECK_IN' && value.type !== 'CHECK_OUT') ||
    !isIsoInstant(value.serverTime) ||
    !VALIDATION_STATUSES.includes(String(value.validationStatus))
  ) {
    throw invalidResponse();
  }

  const store = parseStore(value.store);
  let shift: EmployeeHistoryItem['shift'] = null;
  if (value.shift !== null) {
    if (
      !isRecord(value.shift) ||
      !hasExactKeys(value.shift, ['id', 'name']) ||
      !isUuid(value.shift.id) ||
      typeof value.shift.name !== 'string'
    ) {
      throw invalidResponse();
    }
    shift = { id: value.shift.id, name: value.shift.name };
  }

  return {
    id: value.id,
    date: value.date,
    type: value.type,
    serverTime: value.serverTime,
    validationStatus: value.validationStatus as AttendanceValidationStatus,
    store,
    shift,
  };
}

function parseRequestItem(value: unknown): EmployeeRequestStatusItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REQUEST_KEYS) ||
    !isUuid(value.id) ||
    !REQUEST_TYPES.includes(String(value.requestType)) ||
    !isCalendarDate(value.startDate) ||
    !isCalendarDate(value.endDate) ||
    value.endDate < value.startDate ||
    !REQUEST_STATUSES.includes(String(value.status)) ||
    !isIsoInstant(value.requestedAt) ||
    !(value.decisionAt === null || isIsoInstant(value.decisionAt))
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    requestType: value.requestType as EmployeeRequestStatusItem['requestType'],
    startDate: value.startDate,
    endDate: value.endDate,
    status: value.status as EmployeeRequestStatusItem['status'],
    requestedAt: value.requestedAt,
    decisionAt: value.decisionAt,
  };
}

function parsePage<Item>(
  value: unknown,
  parseItem: (item: unknown) => Item,
  expectedPage: number,
  expectedPageSize: number,
): EmployeeDashboardPage<Item> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAGE_KEYS) ||
    !Array.isArray(value.items) ||
    !validatePage(value.page) ||
    !validatePageSize(value.pageSize) ||
    typeof value.hasNextPage !== 'boolean' ||
    value.page !== expectedPage ||
    value.pageSize !== expectedPageSize ||
    value.items.length > value.pageSize
  ) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseItem),
    page: value.page,
    pageSize: value.pageSize,
    hasNextPage: value.hasNextPage,
  };
}

function parseDashboard(value: unknown, query: EmployeeDashboardQuery): EmployeeDashboard {
  if (!isRecord(value) || !hasExactKeys(value, DASHBOARD_KEYS) || !Array.isArray(value.today)) {
    throw invalidResponse();
  }
  const historyPage = query.historyPage ?? 1;
  const historyPageSize = query.historyPageSize ?? 20;
  const requestPage = query.requestPage ?? 1;
  const requestPageSize = query.requestPageSize ?? 20;
  return {
    today: value.today.map(parseTodayItem),
    history: parsePage(value.history, parseHistoryItem, historyPage, historyPageSize),
    requests: parsePage(value.requests, parseRequestItem, requestPage, requestPageSize),
  };
}

function apiUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function readResponse(response: Response): Promise<unknown> {
  return readApiJson(
    response,
    200,
    ({ status, code, requestId }) => new EmployeeDashboardApiError(status, code, requestId),
  );
}

function serializeQuery(query: EmployeeDashboardQuery): string {
  validateQuery(query);
  const search = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = query[key];
    if (value !== undefined) search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export function createEmployeeDashboardApi(options: EmployeeDashboardApiOptions = {}) {
  const base = options.apiBaseUrl ?? API_BASE_URL;
  const fetchOptions: ApiFetchOptions = {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    errorFactory: ({ status, code, requestId }) =>
      new EmployeeDashboardApiError(status, code, requestId),
  };

  return {
    async getDashboard(
      query: EmployeeDashboardQuery = {},
      requestOptions: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<EmployeeDashboard> {
      const queryString = serializeQuery(query);
      const response = await apiFetch(
        apiUrl(base, `/me/dashboard${queryString}`),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
          headers: { Accept: 'application/json' },
        },
        fetchOptions,
      );
      return parseDashboard(await readResponse(response), query);
    },
  };
}

export const employeeDashboardApi = createEmployeeDashboardApi();
