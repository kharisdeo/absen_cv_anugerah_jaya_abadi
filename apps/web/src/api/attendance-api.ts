import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiErrorDetails, readApiJson } from './api-client.js';
import {
  API_ATTENDANCE_ATTEMPT_STATES,
  API_ATTENDANCE_TYPES,
  API_ATTENDANCE_VALIDATION_METHODS,
  API_ATTENDANCE_VALIDATION_STATUSES,
  API_NETWORK_STATUSES,
  isApiDateTime,
  type ApiAttendanceAttemptState,
  type ApiAttendanceValidationMethod,
  type ApiAttendanceValidationStatus,
  type ApiNetworkStatus,
} from './api-contract.js';

export const MAX_SELFIE_BYTES = 200 * 1024;

export type AttendanceType = (typeof API_ATTENDANCE_TYPES)[number];
export type AttendanceValidationStatus = ApiAttendanceValidationStatus;
export type AttendanceRequestStage = 'intent' | 'upload' | 'attempt';

export type AttendanceLocation = Readonly<{
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}>;

export type AttendanceAttemptBody = Readonly<{
  idempotencyKey: string;
  type: AttendanceType;
  clientRecordedAt: string;
  networkStatus: ApiNetworkStatus;
  location: AttendanceLocation;
  validationMethod: ApiAttendanceValidationMethod;
  selfie: Readonly<{ blob: string; sizeKb: number }>;
  liveness: Readonly<{ faceDetected: boolean; passed: boolean }>;
  proofCode: null;
}>;

/** Immutable serialized body is retained in memory so an ambiguous response can be replayed byte-for-byte. */
export type AttendanceAttemptDraft = Readonly<{
  body: AttendanceAttemptBody;
  serializedBody: string;
}>;

export type AttendanceReceipt = Readonly<{
  attemptId: string;
  state: ApiAttendanceAttemptState;
  type: AttendanceType;
  receivedAt: string;
  replayed: boolean;
  attendanceId?: string;
  validationStatus?: AttendanceValidationStatus;
}>;

export class AttendanceSubmissionError extends ApiClientError {
  constructor(
    status: number,
    code: string,
    readonly stage: AttendanceRequestStage,
    requestId?: string,
  ) {
    super(
      { status, code, ...(requestId ? { requestId } : {}) },
      'Permintaan absensi belum berhasil.',
    );
    this.name = 'AttendanceSubmissionError';
  }
}

type FetchPort = typeof fetch;

export type AttendanceApiOptions = Readonly<{
  apiBaseUrl?: string;
  fetcher?: FetchPort;
  signal?: AbortSignal;
  timeoutMs?: number;
  createIdempotencyKey?: () => string;
  onProgress?: (stage: 'creating-intent' | 'uploading-selfie' | 'sending-attempt') => void;
}>;

export type PrepareAttendanceAttemptInput = Readonly<{
  type: AttendanceType;
  clientRecordedAt: string;
  photo: Blob;
  location: AttendanceLocation;
  liveness: Readonly<{ faceDetected: boolean; passed: boolean }>;
  networkStatus?: ApiNetworkStatus;
  validationMethod?: ApiAttendanceValidationMethod;
}>;

type UploadIntent = Readonly<{
  referenceId: string;
  uploadUrl: string;
  requiredHeaders: Readonly<Record<string, string>>;
  expiresAt: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isIsoInstant(value: unknown): value is string {
  return isApiDateTime(value);
}

function apiUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  stage: AttendanceRequestStage,
  options: AttendanceApiOptions,
): Promise<Response> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 20_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();

  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    return await apiFetch(
      url,
      { ...init, signal: controller.signal },
      {
        fetcher,
        errorFactory: ({ status, code, requestId }) =>
          new AttendanceSubmissionError(status, code ?? 'NETWORK_ERROR', stage, requestId),
      },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timedOut) throw new AttendanceSubmissionError(503, 'REQUEST_TIMEOUT', stage);
    if (error instanceof AttendanceSubmissionError) throw error;
    throw new AttendanceSubmissionError(0, 'NETWORK_ERROR', stage);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1'
  );
}

function parseUploadIntent(value: unknown, expectedContentType: string): UploadIntent {
  const keys = ['referenceId', 'uploadUrl', 'requiredHeaders', 'expiresAt'] as const;
  if (
    !isRecord(value) ||
    !exactKeys(value, keys) ||
    !isUuid(value.referenceId) ||
    typeof value.uploadUrl !== 'string' ||
    !isIsoInstant(value.expiresAt) ||
    !isRecord(value.requiredHeaders)
  ) {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'intent');
  }

  let uploadUrl: URL;
  try {
    uploadUrl = new URL(value.uploadUrl);
  } catch {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'intent');
  }
  const secureOrigin = uploadUrl.protocol === 'https:';
  const localDevelopmentOrigin =
    uploadUrl.protocol === 'http:' && isLoopbackHost(uploadUrl.hostname);
  if ((!secureOrigin && !localDevelopmentOrigin) || uploadUrl.username || uploadUrl.password) {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'intent');
  }

  const requiredHeaders: Record<string, string> = {};
  const seenHeaders = new Set<string>();
  for (const [name, headerValue] of Object.entries(value.requiredHeaders)) {
    const normalizedName = name.toLowerCase();
    if (
      !['content-type', 'x-amz-meta-referencehash'].includes(normalizedName) ||
      seenHeaders.has(normalizedName) ||
      typeof headerValue !== 'string' ||
      !headerValue ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'intent');
    }
    seenHeaders.add(normalizedName);
    requiredHeaders[name] = headerValue;
  }

  const contentTypeEntry = Object.entries(requiredHeaders).find(
    ([name]) => name.toLowerCase() === 'content-type',
  );
  if (
    seenHeaders.size !== 2 ||
    !contentTypeEntry ||
    contentTypeEntry[1] !== expectedContentType ||
    !seenHeaders.has('x-amz-meta-referencehash')
  ) {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'intent');
  }

  return {
    referenceId: value.referenceId,
    uploadUrl: uploadUrl.toString(),
    requiredHeaders,
    expiresAt: value.expiresAt,
  };
}

async function createUploadIntent(
  photo: Blob,
  options: AttendanceApiOptions,
): Promise<UploadIntent> {
  options.onProgress?.('creating-intent');
  const response = await fetchWithTimeout(
    apiUrl(options.apiBaseUrl ?? API_BASE_URL, '/attendance/selfie-upload-intents'),
    {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: photo.type, sizeBytes: photo.size }),
    },
    'intent',
    options,
  );

  if (!response.ok) {
    const details = await readApiErrorDetails(response);
    throw new AttendanceSubmissionError(
      details.status,
      details.code ?? 'REQUEST_FAILED',
      'intent',
      details.requestId,
    );
  }
  if (response.status !== 201) {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'intent');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return parseUploadIntent(payload, photo.type);
}

async function uploadSelfie(
  photo: Blob,
  intent: UploadIntent,
  options: AttendanceApiOptions,
): Promise<void> {
  options.onProgress?.('uploading-selfie');
  const response = await fetchWithTimeout(
    intent.uploadUrl,
    {
      method: 'PUT',
      credentials: 'omit',
      cache: 'no-store',
      headers: intent.requiredHeaders,
      body: photo,
    },
    'upload',
    options,
  );
  if (!response.ok) {
    const code = response.status === 403 ? 'ATTENDANCE_UPLOAD_EXPIRED' : 'ATTENDANCE_UPLOAD_FAILED';
    throw new AttendanceSubmissionError(response.status, code, 'upload');
  }
}

function rounded(value: number, decimalPlaces: number): number {
  return Number(value.toFixed(decimalPlaces));
}

function validatePreparationInput(input: PrepareAttendanceAttemptInput): void {
  if (
    !API_ATTENDANCE_TYPES.includes(input.type) ||
    !isIsoInstant(input.clientRecordedAt) ||
    !(input.photo instanceof Blob) ||
    input.photo.size < 1 ||
    input.photo.size > MAX_SELFIE_BYTES ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(input.photo.type) ||
    !Number.isFinite(input.location.latitude) ||
    input.location.latitude < -90 ||
    input.location.latitude > 90 ||
    !Number.isFinite(input.location.longitude) ||
    input.location.longitude < -180 ||
    input.location.longitude > 180 ||
    !Number.isFinite(input.location.accuracyMeters) ||
    input.location.accuracyMeters <= 0 ||
    typeof input.liveness.faceDetected !== 'boolean' ||
    typeof input.liveness.passed !== 'boolean' ||
    (input.liveness.passed && !input.liveness.faceDetected) ||
    (input.networkStatus !== undefined && !API_NETWORK_STATUSES.includes(input.networkStatus)) ||
    (input.validationMethod !== undefined &&
      !API_ATTENDANCE_VALIDATION_METHODS.includes(input.validationMethod))
  ) {
    throw new AttendanceSubmissionError(400, 'INVALID_ATTENDANCE_ATTEMPT', 'intent');
  }
  if (rounded(input.location.accuracyMeters, 2) <= 0) {
    throw new AttendanceSubmissionError(400, 'INVALID_ATTENDANCE_ATTEMPT', 'intent');
  }
}

function generateIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
    throw new AttendanceSubmissionError(0, 'UUID_UNAVAILABLE', 'attempt');
  }
  return cryptoApi.randomUUID();
}

function createDraft(
  input: PrepareAttendanceAttemptInput,
  intent: UploadIntent,
  options: AttendanceApiOptions,
): AttendanceAttemptDraft {
  const idempotencyKey = (options.createIdempotencyKey ?? generateIdempotencyKey)();
  const sizeKb = Math.ceil(input.photo.size / 1024);
  if (!isUuid(idempotencyKey) || sizeKb < 1 || sizeKb > 200) {
    throw new AttendanceSubmissionError(400, 'INVALID_ATTENDANCE_ATTEMPT', 'attempt');
  }

  const body: AttendanceAttemptBody = Object.freeze({
    idempotencyKey,
    type: input.type,
    clientRecordedAt: input.clientRecordedAt,
    networkStatus: input.networkStatus ?? 'ONLINE',
    location: Object.freeze({
      latitude: rounded(input.location.latitude, 6),
      longitude: rounded(input.location.longitude, 6),
      accuracyMeters: rounded(input.location.accuracyMeters, 2),
    }),
    validationMethod: input.validationMethod ?? 'GPS',
    selfie: Object.freeze({ blob: intent.referenceId, sizeKb }),
    liveness: Object.freeze({ ...input.liveness }),
    proofCode: null,
  });
  return Object.freeze({ body, serializedBody: JSON.stringify(body) });
}

/** Creates an intent and uploads camera bytes; returned draft is ready for the attempt endpoint. */
export async function prepareAttendanceAttempt(
  input: PrepareAttendanceAttemptInput,
  options: AttendanceApiOptions = {},
): Promise<AttendanceAttemptDraft> {
  validatePreparationInput(input);
  const intent = await createUploadIntent(input.photo, options);
  await uploadSelfie(input.photo, intent, options);
  return createDraft(input, intent, options);
}

function parseReceipt(value: unknown, expectedType: AttendanceType): AttendanceReceipt {
  const requiredKeys = ['attemptId', 'state', 'type', 'receivedAt', 'replayed'] as const;
  const allowedKeys = [...requiredKeys, 'attendanceId', 'validationStatus'];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, allowedKeys) ||
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isUuid(value.attemptId) ||
    typeof value.state !== 'string' ||
    !(API_ATTENDANCE_ATTEMPT_STATES as readonly string[]).includes(value.state) ||
    value.type !== expectedType ||
    !isIsoInstant(value.receivedAt) ||
    typeof value.replayed !== 'boolean' ||
    (Object.hasOwn(value, 'attendanceId') && !isUuid(value.attendanceId)) ||
    (Object.hasOwn(value, 'validationStatus') &&
      (typeof value.validationStatus !== 'string' ||
        !(API_ATTENDANCE_VALIDATION_STATUSES as readonly string[]).includes(
          value.validationStatus,
        )))
  ) {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'attempt');
  }

  return {
    attemptId: value.attemptId,
    state: value.state as ApiAttendanceAttemptState,
    type: expectedType,
    receivedAt: value.receivedAt,
    replayed: value.replayed,
    ...(typeof value.attendanceId === 'string' ? { attendanceId: value.attendanceId } : {}),
    ...(typeof value.validationStatus === 'string'
      ? { validationStatus: value.validationStatus as AttendanceValidationStatus }
      : {}),
  };
}

/** Posts the frozen request body. Retrying the same draft reuses identical JSON and idempotency key. */
export async function submitAttendanceAttempt(
  draft: AttendanceAttemptDraft,
  options: AttendanceApiOptions = {},
): Promise<AttendanceReceipt> {
  options.onProgress?.('sending-attempt');
  const response = await fetchWithTimeout(
    apiUrl(options.apiBaseUrl ?? API_BASE_URL, '/attendance/attempts'),
    {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: draft.serializedBody,
    },
    'attempt',
    options,
  );

  if (!response.ok) {
    const details = await readApiErrorDetails(response);
    throw new AttendanceSubmissionError(
      details.status,
      details.code ?? 'REQUEST_FAILED',
      'attempt',
      details.requestId,
    );
  }
  if (response.status !== 200 && response.status !== 202) {
    throw new AttendanceSubmissionError(502, 'INVALID_RESPONSE', 'attempt');
  }

  const payload = await readApiJson(
    response,
    [200, 202],
    ({ status, code, requestId }) =>
      new AttendanceSubmissionError(status, code ?? 'REQUEST_FAILED', 'attempt', requestId),
  );
  return parseReceipt(payload, draft.body.type);
}

/** Retry only ambiguous/transient failures with the original draft; known 4xx responses need a new action. */
export function canRetryAttendanceRequest(error: unknown): boolean {
  if (!(error instanceof AttendanceSubmissionError)) return false;
  if (error.stage === 'upload') {
    return (
      error.status === 0 || error.status === 403 || error.status === 429 || error.status >= 500
    );
  }
  return error.status === 0 || error.status === 429 || error.status >= 500;
}
