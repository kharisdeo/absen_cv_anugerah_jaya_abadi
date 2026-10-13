/** Shared HTTP transport and safe Problem Details mapping for active API clients. */
export type ApiErrorDetails = Readonly<{
  status: number;
  code?: string;
  requestId?: string;
}>;

export type ApiRecoveryAction =
  | 'retry'
  | 'sign-in'
  | 'refresh'
  | 'new-attempt'
  | 'correct-input'
  | 'request-access'
  | 'wait'
  | 'contact-admin'
  | 'none';

export type ApiErrorFactory = (details: ApiErrorDetails) => Error;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly recovery: ApiRecoveryAction;

  constructor(details: ApiErrorDetails, message = 'Permintaan API belum berhasil.') {
    super(message);
    this.name = 'ApiClientError';
    this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    this.recovery = getApiRecoveryAction(details);
  }
}

export function getApiRecoveryAction(details: ApiErrorDetails): ApiRecoveryAction {
  if (details.status === 0) return 'retry';
  if (details.status === 400 || details.status === 422) return 'correct-input';
  if (details.status === 401) return 'sign-in';
  if (details.status === 403) return 'request-access';
  if (details.status === 404) return 'refresh';
  if (details.status === 409) {
    return details.code === 'IDEMPOTENCY_KEY_REUSED' ? 'new-attempt' : 'refresh';
  }
  if (details.status === 429) return 'wait';
  if (details.status >= 500) return 'retry';
  return 'none';
}

export const apiClientErrorFactory: ApiErrorFactory = (details) => new ApiClientError(details);

export type ApiFetchOptions = Readonly<{
  fetcher?: typeof fetch;
  errorFactory?: ApiErrorFactory;
}>;

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * API requests default to cookie credentials and no-store. Explicit RequestInit values win,
 * including credentials:'omit' for signed object-storage PUTs. Headers and bodies are untouched.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ApiFetchOptions = {},
): Promise<Response> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  try {
    return await fetcher(input, {
      credentials: 'include',
      cache: 'no-store',
      ...init,
    });
  } catch (error: unknown) {
    if (init.signal?.aborted || isAbortError(error)) throw error;
    const factory = options.errorFactory ?? apiClientErrorFactory;
    throw factory({ status: 0, code: 'NETWORK_ERROR' });
  }
}

/** Read only safe fields from an RFC 9457-style response; server detail/title are never retained. */
export async function readApiErrorDetails(response: Response): Promise<ApiErrorDetails> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { status: response.status };
  }

  const record = payload as Record<string, unknown>;
  return {
    status: response.status,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
  };
}

export async function readApiJson(
  response: Response,
  expectedStatus: number | readonly number[] = 200,
  errorFactory: ApiErrorFactory = apiClientErrorFactory,
): Promise<unknown> {
  if (!response.ok) throw errorFactory(await readApiErrorDetails(response));

  const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  if (!expectedStatuses.includes(response.status)) {
    throw errorFactory({ status: 502, code: 'INVALID_RESPONSE' });
  }
  // A bodyless success is valid only when the endpoint explicitly declares 204 as expected.
  if (response.status === 204) return undefined;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (payload === null) {
    throw errorFactory({ status: 502, code: 'INVALID_RESPONSE' });
  }
  return payload;
}

export function apiErrorDetailsFromUnknown(error: unknown): ApiErrorDetails | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  const candidate = error as { status?: unknown; code?: unknown; requestId?: unknown };
  if (typeof candidate.status !== 'number') return null;
  return {
    status: candidate.status,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.requestId === 'string' ? { requestId: candidate.requestId } : {}),
  };
}
