import { API_BASE_URL } from '../config.js';
import { REQUEST_STATUSES, type RequestStatus } from '../domain/attendance-state.js';
import { ApiClientError, apiFetch, readApiJson, type ApiFetchOptions } from './api-client.js';
import { API_REQUEST_TYPES, isApiCalendarDate, isApiDateTime } from './api-contract.js';

export const EMPLOYEE_REQUEST_TYPES = API_REQUEST_TYPES;
export type EmployeeRequestType = (typeof EMPLOYEE_REQUEST_TYPES)[number];
export type DoctorNoteContentType = 'image/jpeg' | 'image/png' | 'image/webp';

export type DoctorNoteInput = Readonly<{
  contentType: DoctorNoteContentType;
  dataBase64: string;
}>;

type RequestCreateBase = Readonly<{
  startDate: string;
  endDate: string;
  reason: string;
}>;

export type AttendanceRequestCreateInput =
  | (RequestCreateBase & Readonly<{ requestType: 'LEAVE' }>)
  | (RequestCreateBase & Readonly<{ requestType: 'ANNUAL_LEAVE' }>)
  | (RequestCreateBase & Readonly<{ requestType: 'SICK'; doctorNote: DoctorNoteInput }>)
  | (RequestCreateBase & Readonly<{ requestType: 'OVERTIME'; requestedOvertimeMinutes: number }>);

export type AttendanceRequestDto = Readonly<{
  id: string;
  employee: Readonly<{ id: string; fullName: string }>;
  requestType: EmployeeRequestType;
  startDate: string;
  endDate: string;
  reason: string;
  status: RequestStatus;
  requestedAt: string;
  decisionAt: string | null;
  decisionNote: string | null;
  hasAttachment: boolean;
  requestedOvertimeMinutes: number | null;
  approvedOvertimeMinutes: number;
}>;

export type AttendanceRequestPage = Readonly<{
  items: readonly AttendanceRequestDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export type AttendanceRequestListQuery = Readonly<{
  page: number;
  pageSize: number;
}>;

export class AttendanceRequestsApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan pengajuan belum berhasil.',
    );
    this.name = 'AttendanceRequestsApiError';
  }
}

export type AttendanceRequestsApiOptions = Readonly<{
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}>;

const REQUEST_PATH = '/attendance/requests';
const MAX_DOCTOR_NOTE_BYTES = 5 * 1024 * 1024;
const REQUEST_DTO_KEYS = [
  'id',
  'employee',
  'requestType',
  'startDate',
  'endDate',
  'reason',
  'status',
  'requestedAt',
  'decisionAt',
  'decisionNote',
  'hasAttachment',
  'requestedOvertimeMinutes',
  'approvedOvertimeMinutes',
] as const;
const PAGE_KEYS = ['items', 'page', 'pageSize', 'hasNextPage'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isCalendarDate(value: unknown): value is string {
  return isApiCalendarDate(value);
}

function isIsoInstant(value: unknown): value is string {
  return isApiDateTime(value);
}

function invalidInput(): AttendanceRequestsApiError {
  return new AttendanceRequestsApiError(400, 'INVALID_ATTENDANCE_REQUEST');
}

function invalidResponse(): AttendanceRequestsApiError {
  return new AttendanceRequestsApiError(502, 'INVALID_RESPONSE');
}

function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const isBase64Character =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isBase64Character) return null;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  if ((padding === 1 && dataLength % 4 !== 3) || (padding === 2 && dataLength % 4 !== 2)) {
    return null;
  }
  return (value.length / 4) * 3 - padding;
}

function serializeCreateInput(input: AttendanceRequestCreateInput): Record<string, unknown> {
  const value: unknown = input;
  if (!isRecord(value) || typeof value.requestType !== 'string') throw invalidInput();

  const commonKeys = ['requestType', 'startDate', 'endDate', 'reason'] as const;
  const keys =
    value.requestType === 'SICK'
      ? [...commonKeys, 'doctorNote']
      : value.requestType === 'OVERTIME'
        ? [...commonKeys, 'requestedOvertimeMinutes']
        : commonKeys;

  if (
    !(EMPLOYEE_REQUEST_TYPES as readonly string[]).includes(value.requestType) ||
    !hasExactKeys(value, keys) ||
    !isCalendarDate(value.startDate) ||
    !isCalendarDate(value.endDate) ||
    value.endDate < value.startDate ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length < 1 ||
    [...value.reason.trim()].length > 1_000 ||
    [...value.reason.trim()].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    })
  ) {
    throw invalidInput();
  }

  const base = {
    requestType: value.requestType,
    startDate: value.startDate,
    endDate: value.endDate,
    reason: value.reason.trim(),
  };

  if (value.requestType === 'SICK') {
    if (
      !isRecord(value.doctorNote) ||
      !hasExactKeys(value.doctorNote, ['contentType', 'dataBase64']) ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(String(value.doctorNote.contentType)) ||
      typeof value.doctorNote.dataBase64 !== 'string' ||
      value.doctorNote.dataBase64.length > Math.ceil((MAX_DOCTOR_NOTE_BYTES * 4) / 3) + 4 ||
      (decodedBase64ByteLength(value.doctorNote.dataBase64) ?? MAX_DOCTOR_NOTE_BYTES + 1) < 1 ||
      (decodedBase64ByteLength(value.doctorNote.dataBase64) ?? MAX_DOCTOR_NOTE_BYTES + 1) >
        MAX_DOCTOR_NOTE_BYTES
    ) {
      throw invalidInput();
    }
    return {
      ...base,
      doctorNote: {
        contentType: value.doctorNote.contentType,
        dataBase64: value.doctorNote.dataBase64,
      },
    };
  }

  if (value.requestType === 'OVERTIME') {
    if (
      typeof value.requestedOvertimeMinutes !== 'number' ||
      !Number.isInteger(value.requestedOvertimeMinutes) ||
      value.requestedOvertimeMinutes < 1 ||
      value.requestedOvertimeMinutes > 2_147_483_647
    ) {
      throw invalidInput();
    }
    return { ...base, requestedOvertimeMinutes: value.requestedOvertimeMinutes };
  }

  return base;
}

function parseRequestDto(value: unknown): AttendanceRequestDto {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REQUEST_DTO_KEYS) ||
    !isUuid(value.id) ||
    !isRecord(value.employee) ||
    !hasExactKeys(value.employee, ['id', 'fullName']) ||
    !isUuid(value.employee.id) ||
    typeof value.employee.fullName !== 'string' ||
    !(EMPLOYEE_REQUEST_TYPES as readonly unknown[]).includes(value.requestType) ||
    !isCalendarDate(value.startDate) ||
    !isCalendarDate(value.endDate) ||
    value.endDate < value.startDate ||
    typeof value.reason !== 'string' ||
    !(REQUEST_STATUSES as readonly unknown[]).includes(value.status) ||
    !isIsoInstant(value.requestedAt) ||
    !(value.decisionAt === null || isIsoInstant(value.decisionAt)) ||
    !(value.decisionNote === null || typeof value.decisionNote === 'string') ||
    typeof value.hasAttachment !== 'boolean' ||
    !(
      value.requestedOvertimeMinutes === null ||
      (typeof value.requestedOvertimeMinutes === 'number' &&
        Number.isInteger(value.requestedOvertimeMinutes) &&
        value.requestedOvertimeMinutes > 0)
    ) ||
    typeof value.approvedOvertimeMinutes !== 'number' ||
    !Number.isInteger(value.approvedOvertimeMinutes) ||
    value.approvedOvertimeMinutes < 0 ||
    (value.hasAttachment && value.requestType !== 'SICK')
  ) {
    throw invalidResponse();
  }

  return {
    id: value.id,
    employee: { id: value.employee.id, fullName: value.employee.fullName },
    requestType: value.requestType as EmployeeRequestType,
    startDate: value.startDate,
    endDate: value.endDate,
    reason: value.reason,
    status: value.status as RequestStatus,
    requestedAt: value.requestedAt,
    decisionAt: value.decisionAt,
    decisionNote: value.decisionNote,
    hasAttachment: value.hasAttachment,
    requestedOvertimeMinutes: value.requestedOvertimeMinutes,
    approvedOvertimeMinutes: value.approvedOvertimeMinutes,
  };
}

function parseRequestPage(value: unknown): AttendanceRequestPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAGE_KEYS) ||
    !Array.isArray(value.items) ||
    !Number.isInteger(value.page) ||
    (value.page as number) < 1 ||
    !Number.isInteger(value.pageSize) ||
    (value.pageSize as number) < 1 ||
    (value.pageSize as number) > 50 ||
    typeof value.hasNextPage !== 'boolean'
  ) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(parseRequestDto),
    page: value.page as number,
    pageSize: value.pageSize as number,
    hasNextPage: value.hasNextPage,
  };
}

async function readJson(response: Response, expectedStatus: number): Promise<unknown> {
  return readApiJson(
    response,
    expectedStatus,
    ({ status, code, requestId }) => new AttendanceRequestsApiError(status, code, requestId),
  );
}

function apiUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export function createAttendanceRequestsApi(options: AttendanceRequestsApiOptions = {}) {
  const base = options.apiBaseUrl ?? API_BASE_URL;
  const fetchOptions: ApiFetchOptions = {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    errorFactory: ({ status, code, requestId }) =>
      new AttendanceRequestsApiError(status, code, requestId),
  };

  return {
    async listRequests(
      query: AttendanceRequestListQuery,
      signal?: AbortSignal,
    ): Promise<AttendanceRequestPage> {
      if (
        !Number.isInteger(query.page) ||
        query.page < 1 ||
        query.page > 10_000 ||
        !Number.isInteger(query.pageSize) ||
        query.pageSize < 1 ||
        query.pageSize > 50
      ) {
        throw invalidInput();
      }
      const search = new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
      });
      const response = await apiFetch(
        apiUrl(base, `${REQUEST_PATH}?${search.toString()}`),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          headers: { Accept: 'application/json' },
        },
        fetchOptions,
      );
      return parseRequestPage(await readJson(response, 200));
    },

    async createRequest(input: AttendanceRequestCreateInput): Promise<AttendanceRequestDto> {
      const body = serializeCreateInput(input);
      const response = await apiFetch(
        apiUrl(base, REQUEST_PATH),
        {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        fetchOptions,
      );
      return parseRequestDto(await readJson(response, 201));
    },
  };
}

export const attendanceRequestsApi = createAttendanceRequestsApi();
