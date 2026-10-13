import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from '../api/api-client.js';

export type LoginDeviceInfo = Readonly<{
  deviceToken: string;
  deviceName: string;
}>;

/** A future owner-approved device-ID provider can be injected here; this task stores nothing. */
export type LoginDeviceInfoProvider = () => Promise<LoginDeviceInfo | null>;

export const noLoginDeviceInfo: LoginDeviceInfoProvider = async () => null;

export type ConsentPolicy = Readonly<{
  version: string;
  text: string;
  purposes: readonly Readonly<{ id: string; label: string }>[];
}>;

export type CurrentConsentResponse = Readonly<{
  policy: ConsentPolicy;
  consentRequired: boolean;
}>;

export class AuthApiError extends ApiClientError {
  constructor(status: number, code?: string, requestId?: string) {
    super(
      { status, ...(code === undefined ? {} : { code }), ...(requestId ? { requestId } : {}) },
      'Permintaan autentikasi belum berhasil.',
    );
    this.name = 'AuthApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestJson(
  path: string,
  method: 'GET' | 'POST',
  body?: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await apiFetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: 'include',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  return readApiJson(
    response,
    200,
    ({ status, code, requestId }) => new AuthApiError(status, code, requestId),
  );
}

export async function login(
  identifier: string,
  password: string,
  getDeviceInfo: LoginDeviceInfoProvider = noLoginDeviceInfo,
): Promise<void> {
  const deviceInfo = await getDeviceInfo();
  const validDeviceInfo =
    deviceInfo &&
    typeof deviceInfo.deviceToken === 'string' &&
    deviceInfo.deviceToken.length > 0 &&
    typeof deviceInfo.deviceName === 'string' &&
    deviceInfo.deviceName.length > 0
      ? deviceInfo
      : null;

  await requestJson('/auth/login', 'POST', {
    identifier,
    password,
    ...(validDeviceInfo ?? {}),
  });
}

export async function getCurrentConsent(signal?: AbortSignal): Promise<CurrentConsentResponse> {
  const payload = await requestJson('/consents/current', 'GET', undefined, signal);
  if (!isRecord(payload) || typeof payload.consentRequired !== 'boolean') {
    throw new AuthApiError(502, 'INVALID_RESPONSE');
  }

  const policy = payload.policy;
  if (
    !isRecord(policy) ||
    typeof policy.version !== 'string' ||
    typeof policy.text !== 'string' ||
    !Array.isArray(policy.purposes)
  ) {
    throw new AuthApiError(502, 'INVALID_RESPONSE');
  }

  const purposes: ConsentPolicy['purposes'][number][] = [];
  for (const purpose of policy.purposes) {
    if (!isRecord(purpose) || typeof purpose.id !== 'string' || typeof purpose.label !== 'string') {
      throw new AuthApiError(502, 'INVALID_RESPONSE');
    }
    purposes.push({ id: purpose.id, label: purpose.label });
  }

  return {
    consentRequired: payload.consentRequired,
    policy: {
      version: policy.version,
      // Preserve the server-approved wording exactly; presentation must not rewrite it.
      text: policy.text,
      purposes,
    },
  };
}

export async function acceptCurrentConsent(policyVersion: string): Promise<void> {
  await requestJson('/consents', 'POST', { policyVersion, accepted: true });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await requestJson('/auth/change-password', 'POST', { currentPassword, newPassword });
}

export function isSessionExpiryError(error: unknown): error is AuthApiError {
  return (
    error instanceof AuthApiError &&
    error.status === 401 &&
    (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')
  );
}
