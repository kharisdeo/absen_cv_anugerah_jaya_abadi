import { API_BASE_URL } from '../config.js';
import type { RequestStatus } from '../domain/attendance-state.js';
import { ApiClientError, apiFetch, readApiJson, type ApiFetchOptions } from './api-client.js';
import {
  API_ATTENDANCE_TYPES,
  API_ATTENDANCE_VALIDATION_METHODS,
  API_ATTENDANCE_VALIDATION_STATUSES,
  API_NETWORK_STATUSES,
  API_REQUEST_STATUSES,
  API_REQUEST_TYPES,
  isApiCalendarDate,
  isApiDateTime,
} from './api-contract.js';

export type ReviewerRole = 'SUPERVISOR' | 'ADMIN';
export type VerificationDecision = 'APPROVED' | 'REJECTED';
export type AttendanceReviewType = (typeof API_ATTENDANCE_TYPES)[number];
export type AttendanceReviewStatus = (typeof API_ATTENDANCE_VALIDATION_STATUSES)[number];
export type AttendanceReviewMethod = (typeof API_ATTENDANCE_VALIDATION_METHODS)[number];
export type AttendanceNetworkStatus = (typeof API_NETWORK_STATUSES)[number];
export type ReviewRequestType = (typeof API_REQUEST_TYPES)[number];

export type SignedReviewSelfie = Readonly<{ url: string; expiresAt: string }>;
export type SignedRequestAttachment = Readonly<{ url: string; expiresAt: string }>;
export type AttendanceReviewHistoryItem = Readonly<{
  attendanceId: string;
  type: AttendanceReviewType;
  workDate: string;
  serverTime: string;
  deviceTime: string | null;
  validationStatus: AttendanceReviewStatus;
  reason: string | null;
  store: Readonly<{ id: string; name: string }> | null;
}>;
export type AttendanceVerificationDto = Readonly<{
  attendanceId: string;
  employee: Readonly<{ id: string; fullName: string; position: string | null }>;
  store: Readonly<{ id: string; name: string }> | null;
  type: AttendanceReviewType;
  workDate: string;
  serverTime: string;
  deviceTime: string | null;
  dueAt: string;
  overdue: boolean;
  validationStatus: 'PENDING_VERIFICATION';
  method: AttendanceReviewMethod;
  networkStatus: AttendanceNetworkStatus;
  device: Readonly<{ name: string | null }>;
  location: Readonly<{
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    distanceMeters: number | null;
  }> | null;
  selfie: SignedReviewSelfie | null;
  recentAttendance: readonly AttendanceReviewHistoryItem[];
}>;
export type AttendanceVerificationPage = Readonly<{
  items: readonly AttendanceVerificationDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;
export type ReviewerRequestDto = Readonly<{
  id: string;
  employee: Readonly<{ id: string; fullName: string }>;
  requestType: ReviewRequestType;
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
export type ReviewerRequestPage = Readonly<{
  items: readonly ReviewerRequestDto[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

export class AttendanceReviewApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan review belum berhasil.',
    );
    this.name = 'AttendanceReviewApiError';
  }
}

export type AttendanceReviewApiOptions = Readonly<{
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}>;

const VERIFICATION_PATH = '/attendance/verifications';
const REQUEST_PATH = '/attendance/requests';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TYPES: readonly string[] = API_REQUEST_TYPES;
const REQUEST_STATUSES: readonly string[] = API_REQUEST_STATUSES;
const ATTENDANCE_TYPES: readonly string[] = API_ATTENDANCE_TYPES;
const ATTENDANCE_STATUSES: readonly string[] = API_ATTENDANCE_VALIDATION_STATUSES;
const METHODS: readonly string[] = API_ATTENDANCE_VALIDATION_METHODS;
const NETWORK_STATUSES: readonly string[] = API_NETWORK_STATUSES;
const VERIFICATION_ITEM_KEYS = [
  'attendanceId',
  'employee',
  'store',
  'type',
  'workDate',
  'serverTime',
  'deviceTime',
  'dueAt',
  'overdue',
  'validationStatus',
  'method',
  'networkStatus',
  'device',
  'location',
  'selfie',
  'recentAttendance',
] as const;
const REQUEST_KEYS = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCalendarDate(value: unknown): value is string {
  return isApiCalendarDate(value);
}

function isIsoInstant(value: unknown): value is string {
  return isApiDateTime(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function invalidInput(): AttendanceReviewApiError {
  return new AttendanceReviewApiError(400, 'INVALID_REVIEW_INPUT');
}

function invalidResponse(): AttendanceReviewApiError {
  return new AttendanceReviewApiError(502, 'INVALID_RESPONSE');
}

function isStore(value: unknown): value is Readonly<{ id: string; name: string }> | null {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['id', 'name']) &&
      isUuid(value.id) &&
      typeof value.name === 'string')
  );
}

function parseSignedUrlDto(value: unknown): SignedReviewSelfie | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['url', 'expiresAt']) ||
    typeof value.url !== 'string' ||
    value.url.length < 1 ||
    value.url.length > 8_192 ||
    !isIsoInstant(value.expiresAt)
  ) {
    throw invalidResponse();
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw invalidResponse();
  }
  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
  ) {
    throw invalidResponse();
  }
  return { url: value.url, expiresAt: value.expiresAt };
}

function parseHistoryItem(value: unknown): AttendanceReviewHistoryItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attendanceId',
      'type',
      'workDate',
      'serverTime',
      'deviceTime',
      'validationStatus',
      'reason',
      'store',
    ]) ||
    !isUuid(value.attendanceId) ||
    !ATTENDANCE_TYPES.includes(String(value.type)) ||
    !isCalendarDate(value.workDate) ||
    !isIsoInstant(value.serverTime) ||
    !(value.deviceTime === null || isIsoInstant(value.deviceTime)) ||
    !ATTENDANCE_STATUSES.includes(String(value.validationStatus)) ||
    !isNullableString(value.reason) ||
    !isStore(value.store)
  ) {
    throw invalidResponse();
  }
  return {
    attendanceId: value.attendanceId,
    type: value.type as AttendanceReviewType,
    workDate: value.workDate,
    serverTime: value.serverTime,
    deviceTime: value.deviceTime,
    validationStatus: value.validationStatus as AttendanceReviewStatus,
    reason: value.reason,
    store: value.store,
  };
}

function parseVerificationItem(value: unknown, includeSelfie: boolean): AttendanceVerificationDto {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, VERIFICATION_ITEM_KEYS) ||
    !isUuid(value.attendanceId) ||
    !isRecord(value.employee) ||
    !hasExactKeys(value.employee, ['id', 'fullName', 'position']) ||
    !isUuid(value.employee.id) ||
    typeof value.employee.fullName !== 'string' ||
    !isNullableString(value.employee.position) ||
    !isStore(value.store) ||
    !ATTENDANCE_TYPES.includes(String(value.type)) ||
    !isCalendarDate(value.workDate) ||
    !isIsoInstant(value.serverTime) ||
    !(value.deviceTime === null || isIsoInstant(value.deviceTime)) ||
    !isIsoInstant(value.dueAt) ||
    typeof value.overdue !== 'boolean' ||
    value.validationStatus !== 'PENDING_VERIFICATION' ||
    !METHODS.includes(String(value.method)) ||
    !NETWORK_STATUSES.includes(String(value.networkStatus)) ||
    !isRecord(value.device) ||
    !hasExactKeys(value.device, ['name']) ||
    !isNullableString(value.device.name) ||
    !(
      value.location === null ||
      (isRecord(value.location) &&
        hasExactKeys(value.location, [
          'latitude',
          'longitude',
          'accuracyMeters',
          'distanceMeters',
        ]) &&
        typeof value.location.latitude === 'number' &&
        Number.isFinite(value.location.latitude) &&
        value.location.latitude >= -90 &&
        value.location.latitude <= 90 &&
        typeof value.location.longitude === 'number' &&
        Number.isFinite(value.location.longitude) &&
        value.location.longitude >= -180 &&
        value.location.longitude <= 180 &&
        typeof value.location.accuracyMeters === 'number' &&
        Number.isFinite(value.location.accuracyMeters) &&
        value.location.accuracyMeters >= 0 &&
        (value.location.distanceMeters === null ||
          (typeof value.location.distanceMeters === 'number' &&
            Number.isFinite(value.location.distanceMeters) &&
            value.location.distanceMeters >= 0)))
    ) ||
    !Array.isArray(value.recentAttendance) ||
    value.recentAttendance.length > 10
  ) {
    throw invalidResponse();
  }

  const selfie = parseSignedUrlDto(value.selfie);
  return {
    attendanceId: value.attendanceId,
    employee: {
      id: value.employee.id,
      fullName: value.employee.fullName,
      position: value.employee.position,
    },
    store: value.store,
    type: value.type as AttendanceReviewType,
    workDate: value.workDate,
    serverTime: value.serverTime,
    deviceTime: value.deviceTime,
    dueAt: value.dueAt,
    overdue: value.overdue,
    validationStatus: 'PENDING_VERIFICATION',
    method: value.method as AttendanceReviewMethod,
    networkStatus: value.networkStatus as AttendanceNetworkStatus,
    device: { name: value.device.name },
    location:
      value.location === null
        ? null
        : {
            latitude: value.location.latitude as number,
            longitude: value.location.longitude as number,
            accuracyMeters: value.location.accuracyMeters as number,
            distanceMeters: value.location.distanceMeters as number | null,
          },
    // Queue responses contain signed URLs too. Validate and immediately discard them; only an
    // explicitly opened detail retains a URL in transient component memory.
    selfie: includeSelfie ? selfie : null,
    recentAttendance: value.recentAttendance.map(parseHistoryItem),
  };
}

function parseVerificationPage(value: unknown): AttendanceVerificationPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'page', 'pageSize', 'hasNextPage']) ||
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
    items: value.items.map((item) => parseVerificationItem(item, false)),
    page: value.page as number,
    pageSize: value.pageSize as number,
    hasNextPage: value.hasNextPage,
  };
}

function parseRequestDto(value: unknown): ReviewerRequestDto {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REQUEST_KEYS) ||
    !isUuid(value.id) ||
    !isRecord(value.employee) ||
    !hasExactKeys(value.employee, ['id', 'fullName']) ||
    !isUuid(value.employee.id) ||
    typeof value.employee.fullName !== 'string' ||
    !REQUEST_TYPES.includes(String(value.requestType)) ||
    !isCalendarDate(value.startDate) ||
    !isCalendarDate(value.endDate) ||
    value.endDate < value.startDate ||
    typeof value.reason !== 'string' ||
    !REQUEST_STATUSES.includes(String(value.status)) ||
    !isIsoInstant(value.requestedAt) ||
    !(value.decisionAt === null || isIsoInstant(value.decisionAt)) ||
    !isNullableString(value.decisionNote) ||
    typeof value.hasAttachment !== 'boolean' ||
    (value.requestedOvertimeMinutes !== null &&
      (typeof value.requestedOvertimeMinutes !== 'number' ||
        !Number.isInteger(value.requestedOvertimeMinutes) ||
        value.requestedOvertimeMinutes < 1)) ||
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
    requestType: value.requestType as ReviewRequestType,
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

function parseRequestPage(value: unknown): ReviewerRequestPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'page', 'pageSize', 'hasNextPage']) ||
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

function normalizeReason(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw invalidInput();
  const reason = value.trim();
  if (
    (required && reason.length === 0) ||
    reason.length > 500 ||
    [...reason].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 11 && code <= 31) || code === 127;
    })
  ) {
    throw invalidInput();
  }
  return reason;
}

function serializeVerificationDecision(input: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(input) || !['APPROVED', 'REJECTED'].includes(String(input.decision))) {
    throw invalidInput();
  }
  const hasReason = Object.hasOwn(input, 'reason');
  if (!hasExactKeys(input, hasReason ? ['decision', 'reason'] : ['decision'])) {
    throw invalidInput();
  }
  const reason = normalizeReason(input.reason, input.decision === 'REJECTED');
  return {
    decision: input.decision,
    ...(reason === undefined ? {} : { reason }),
  };
}

function serializeRequestDecision(
  input: unknown,
): Readonly<{ decision: string; decisionNote: string }> {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['decision', 'decisionNote']) ||
    (input.decision !== 'APPROVED' && input.decision !== 'REJECTED')
  ) {
    throw invalidInput();
  }
  const decisionNote = normalizeReason(input.decisionNote, true);
  if (!decisionNote) throw invalidInput();
  return { decision: input.decision, decisionNote };
}

async function readJson(response: Response, expectedStatus = 200): Promise<unknown> {
  return readApiJson(
    response,
    expectedStatus,
    ({ status, code, requestId }) => new AttendanceReviewApiError(status, code, requestId),
  );
}

function apiUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

function assertPageQuery(
  query: unknown,
): asserts query is Readonly<{ page: number; pageSize: number }> {
  if (
    !isRecord(query) ||
    !hasExactKeys(query, ['page', 'pageSize']) ||
    !Number.isInteger(query.page) ||
    (query.page as number) < 1 ||
    (query.page as number) > 10_000 ||
    !Number.isInteger(query.pageSize) ||
    (query.pageSize as number) < 1 ||
    (query.pageSize as number) > 50
  ) {
    throw invalidInput();
  }
}

function assertId(id: unknown): asserts id is string {
  if (!isUuid(id)) throw invalidInput();
}

export function createAttendanceReviewApi(options: AttendanceReviewApiOptions = {}) {
  const base = options.apiBaseUrl ?? API_BASE_URL;
  const fetchOptions: ApiFetchOptions = {
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    errorFactory: ({ status, code, requestId }) =>
      new AttendanceReviewApiError(status, code, requestId),
  };

  return {
    async listVerifications(
      query: Readonly<{ page: number; pageSize: number }>,
      signal?: AbortSignal,
    ): Promise<AttendanceVerificationPage> {
      assertPageQuery(query);
      const search = new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
      });
      const response = await apiFetch(
        apiUrl(base, `${VERIFICATION_PATH}?${search.toString()}`),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          headers: { Accept: 'application/json' },
        },
        fetchOptions,
      );
      return parseVerificationPage(await readJson(response));
    },

    async getVerificationDetail(
      attendanceId: string,
      signal?: AbortSignal,
    ): Promise<AttendanceVerificationDto> {
      assertId(attendanceId);
      const response = await apiFetch(
        apiUrl(base, `${VERIFICATION_PATH}/${encodeURIComponent(attendanceId)}`),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          headers: { Accept: 'application/json' },
        },
        fetchOptions,
      );
      return parseVerificationItem(await readJson(response), true);
    },

    async getVerificationSelfieUrl(
      attendanceId: string,
      signal?: AbortSignal,
    ): Promise<SignedReviewSelfie> {
      assertId(attendanceId);
      const response = await apiFetch(
        apiUrl(base, `${VERIFICATION_PATH}/${encodeURIComponent(attendanceId)}/selfie-url`),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          headers: { Accept: 'application/json' },
        },
        fetchOptions,
      );
      const result = parseSignedUrlDto(await readJson(response));
      if (!result) throw invalidResponse();
      return result;
    },

    async decideVerification(
      attendanceId: string,
      input: Readonly<{ decision: VerificationDecision; reason?: string }>,
    ): Promise<Readonly<{ attendanceId: string; validationStatus: VerificationDecision }>> {
      assertId(attendanceId);
      const body = serializeVerificationDecision(input);
      const response = await apiFetch(
        apiUrl(base, `${VERIFICATION_PATH}/${encodeURIComponent(attendanceId)}/decision`),
        {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        fetchOptions,
      );
      const payload = await readJson(response);
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, [
          'attendanceId',
          'validationStatus',
          'reviewedAt',
          'serverTime',
          'deviceTime',
        ]) ||
        payload.attendanceId !== attendanceId ||
        (payload.validationStatus !== 'APPROVED' && payload.validationStatus !== 'REJECTED') ||
        !isIsoInstant(payload.reviewedAt) ||
        !isIsoInstant(payload.serverTime) ||
        !(payload.deviceTime === null || isIsoInstant(payload.deviceTime))
      ) {
        throw invalidResponse();
      }
      return { attendanceId, validationStatus: payload.validationStatus };
    },

    async listRequests(
      query: Readonly<{ page: number; pageSize: number }>,
      signal?: AbortSignal,
    ): Promise<ReviewerRequestPage> {
      assertPageQuery(query);
      const search = new URLSearchParams({
        status: 'PENDING',
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
      return parseRequestPage(await readJson(response));
    },

    async getRequestAttachmentUrl(
      requestId: string,
      signal?: AbortSignal,
    ): Promise<SignedRequestAttachment> {
      assertId(requestId);
      const response = await apiFetch(
        apiUrl(base, `${REQUEST_PATH}/${encodeURIComponent(requestId)}/attachment-url`),
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          ...(signal ? { signal } : {}),
          headers: { Accept: 'application/json' },
        },
        fetchOptions,
      );
      const result = parseSignedUrlDto(await readJson(response));
      if (!result) throw invalidResponse();
      return result;
    },

    async decideRequest(
      requestId: string,
      input: Readonly<{ decision: VerificationDecision; decisionNote: string }>,
    ): Promise<ReviewerRequestDto> {
      assertId(requestId);
      const body = serializeRequestDecision(input);
      const response = await apiFetch(
        apiUrl(base, `${REQUEST_PATH}/${encodeURIComponent(requestId)}/decision`),
        {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        fetchOptions,
      );
      return parseRequestDto(await readJson(response));
    },
  };
}

export const attendanceReviewApi = createAttendanceReviewApi();
