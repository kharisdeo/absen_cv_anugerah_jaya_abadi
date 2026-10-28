import { API_BASE_URL } from '../config.js';
import { ApiClientError, apiFetch, readApiJson } from '../api/api-client.js';

export type LoginDeviceInfo = Readonly<{
  deviceToken: string;
  deviceName: string;
}>;

/** A browser-local device identifier; credentials and session data are never persisted here. */
export type LoginDeviceInfoProvider = () => Promise<LoginDeviceInfo | null>;

const DEVICE_TOKEN_STORAGE_KEY = 'absen_device_token';
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function createDeviceName(): string {
  let userAgent = '';
  try {
    userAgent = globalThis.navigator?.userAgent ?? '';
  } catch {
    // The generic label below keeps login usable in restricted browser contexts.
  }

  let browser = 'Browser';
  if (/Edg(?:A|iOS)?\//.test(userAgent)) browser = 'Microsoft Edge';
  else if (/OPR\//.test(userAgent)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(userAgent)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(userAgent)) browser = 'Chrome';
  else if (/Safari\//.test(userAgent)) browser = 'Safari';

  let platform = '';
  if (/Android/i.test(userAgent)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(userAgent)) platform = 'iOS';
  else if (/Windows NT/i.test(userAgent)) platform = 'Windows';
  else if (/Macintosh|Mac OS/i.test(userAgent)) platform = 'macOS';
  else if (/Linux/i.test(userAgent)) platform = 'Linux';

  return platform ? `${browser} (${platform})` : browser;
}

function createDeviceToken(): string | null {
  try {
    const webCrypto = globalThis.crypto;
    if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') return null;

    // 192 bits of secure randomness, encoded as 48 lowercase hexadecimal characters.
    const bytes = webCrypto.getRandomValues(new Uint8Array(24));
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return DEVICE_TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

function normalizeLoginDeviceInfo(value: unknown): LoginDeviceInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.deviceToken !== 'string' ||
    !DEVICE_TOKEN_PATTERN.test(candidate.deviceToken)
  ) {
    return null;
  }
  if (typeof candidate.deviceName !== 'string') return null;

  const deviceName = candidate.deviceName.trim();
  if (
    deviceName.length < 1 ||
    deviceName.length > 100 ||
    hasControlCharacters(deviceName) ||
    deviceName.includes(candidate.deviceToken)
  ) {
    return null;
  }

  return { deviceToken: candidate.deviceToken, deviceName };
}

export const noLoginDeviceInfo: LoginDeviceInfoProvider = async () => {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;

    let deviceToken = storage.getItem(DEVICE_TOKEN_STORAGE_KEY);
    if (typeof deviceToken !== 'string' || !DEVICE_TOKEN_PATTERN.test(deviceToken)) {
      deviceToken = createDeviceToken();
      if (!deviceToken) return null;
      // Persist only the random device identifier. Passwords and session tokens stay server-side.
      storage.setItem(DEVICE_TOKEN_STORAGE_KEY, deviceToken);
    }

    return normalizeLoginDeviceInfo({ deviceToken, deviceName: createDeviceName() });
  } catch {
    // Storage can be disabled or throw in private/restricted browser contexts; omit device data.
    return null;
  }
};

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
  expectedStatus: number | readonly number[] = 200,
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
    expectedStatus,
    ({ status, code, requestId }) => new AuthApiError(status, code, requestId),
  );
}

export async function login(
  identifier: string,
  password: string,
  getDeviceInfo: LoginDeviceInfoProvider = noLoginDeviceInfo,
): Promise<void> {
  let validDeviceInfo: LoginDeviceInfo | null = null;
  try {
    validDeviceInfo = normalizeLoginDeviceInfo(await getDeviceInfo());
  } catch {
    // Device identity is optional for accounts that do not require device enrollment.
  }

  await requestJson('/auth/login', 'POST', {
    identifier,
    password,
    ...(validDeviceInfo ?? {}),
  });
}

/** Revoke the server-side cookie session. The endpoint confirms success with 204 No Content. */
export async function logout(): Promise<void> {
  await requestJson('/auth/logout', 'POST', undefined, undefined, 204);
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
