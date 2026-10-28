import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toUserErrorMessage } from '../src/api/error-message.js';
import {
  acceptCurrentConsent,
  AuthApiError,
  changePassword,
  getCurrentConsent,
  isSessionExpiryError,
  login,
  logout,
} from '../src/auth/auth-api.js';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(callIndex = 0): Record<string, unknown> {
  const body = fetchMock.mock.calls[callIndex]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(body) as Record<string, unknown>;
}

function stubDeviceEnvironment(
  options: { storageAvailable?: boolean; cryptoAvailable?: boolean } = {},
) {
  const entries = new Map<string, string>();
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(0xab);
    return bytes;
  });

  if (options.storageAvailable === false) {
    vi.stubGlobal('localStorage', undefined);
  } else {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => entries.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => entries.set(key, value)),
    });
  }

  vi.stubGlobal(
    'crypto',
    options.cryptoAvailable === false ? undefined : ({ getRandomValues } as unknown as Crypto),
  );
  vi.stubGlobal('navigator', {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36',
  } as unknown as Navigator);

  return { entries, getRandomValues };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth API client', () => {
  it('keeps credential-only login compatible when browser device APIs are unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('crypto', undefined);
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, consentRequired: false }));

    await login('admin', 'secret-password');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    });
    expect(requestBody()).toEqual({ identifier: 'admin', password: 'secret-password' });
  });

  it.each([
    { unavailable: 'localStorage', options: { storageAvailable: false } },
    { unavailable: 'Web Crypto', options: { cryptoAvailable: false } },
  ])('keeps login working when $unavailable is unavailable', async ({ options }) => {
    stubDeviceEnvironment(options);
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, consentRequired: false }));

    await login('admin', 'secret-password');

    expect(requestBody()).toEqual({ identifier: 'admin', password: 'secret-password' });
  });

  it('generates a valid stable device identity and persists only its token', async () => {
    const { entries, getRandomValues } = stubDeviceEnvironment();
    fetchMock.mockImplementation(async () => jsonResponse({ user: {}, consentRequired: false }));

    await login('employee', 'secret-password');
    await login('employee', 'secret-password');

    const firstRequest = requestBody(0);
    const secondRequest = requestBody(1);
    const token = firstRequest.deviceToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(token).toHaveLength(48);
    expect(firstRequest.deviceName).toBe('Chrome (Windows)');
    expect(firstRequest.deviceName).not.toContain(token as string);
    expect(secondRequest.deviceToken).toBe(token);
    expect(secondRequest.deviceName).toBe(firstRequest.deviceName);
    expect([...entries.keys()]).toEqual(['absen_device_token']);
    expect([...entries.values()]).toEqual([token]);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicitly injected device identity without storing or changing it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, consentRequired: false }));
    const deviceInfo = { deviceToken: 'A'.repeat(32), deviceName: 'Peramban kerja' };

    await login('employee', 'secret-password', async () => deviceInfo);

    expect(requestBody()).toEqual({
      identifier: 'employee',
      password: 'secret-password',
      ...deviceInfo,
    });
  });

  it.each([
    { label: 'short token', deviceInfo: { deviceToken: 'too-short', deviceName: 'Browser' } },
    {
      label: 'long device name',
      deviceInfo: { deviceToken: 'A'.repeat(32), deviceName: 'B'.repeat(101) },
    },
  ])('does not send malformed device metadata ($label)', async ({ deviceInfo }) => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, consentRequired: false }));

    await login('admin', 'secret-password', async () => deviceInfo);

    expect(requestBody()).toEqual({ identifier: 'admin', password: 'secret-password' });
  });

  it('revokes the server session with a cookie-authenticated POST and accepts 204 No Content', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(logout()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/logout');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('does not treat a failed logout response as successful', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'INTERNAL_SERVER_ERROR' }, 500));

    await expect(logout()).rejects.toMatchObject({ status: 500, code: 'INTERNAL_SERVER_ERROR' });
  });

  it('normalizes credential failures and never forwards server detail to the UI', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          code: 'INVALID_CREDENTIALS',
          title: 'Internal title',
          detail: 'private account lookup result',
          requestId: 'private-request-id',
        },
        401,
      ),
    );

    let caught: unknown;
    try {
      await login('unknown-user', 'wrong-password');
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(toUserErrorMessage(caught)).toBe('ID pengguna atau password tidak sesuai.');
    expect(toUserErrorMessage(caught)).not.toContain('private account lookup result');
    expect(toUserErrorMessage(caught)).not.toContain('private-request-id');
  });

  it('renders the exact current server policy contract and preserves approved text', async () => {
    const policyText = 'Kebijakan versi uji.\n\nBaris kedua dipertahankan.';
    fetchMock.mockResolvedValue(
      jsonResponse({
        consentRequired: true,
        policy: {
          version: 'v-test',
          text: policyText,
          purposes: [{ id: 'attendance', label: 'Pencatatan absensi.' }],
        },
      }),
    );

    const result = await getCurrentConsent();

    expect(result).toEqual({
      consentRequired: true,
      policy: {
        version: 'v-test',
        text: policyText,
        purposes: [{ id: 'attendance', label: 'Pencatatan absensi.' }],
      },
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
  });

  it('rejects a malformed consent response instead of showing a fabricated policy', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ consentRequired: true, policy: { text: 'not enough' } }),
    );

    await expect(getCurrentConsent()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    });
  });

  it('posts only the server policy version and explicit consent choice', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ policyVersion: 'v-test', alreadyAccepted: false }));

    await acceptCurrentConsent('v-test');

    expect(requestBody()).toEqual({ policyVersion: 'v-test', accepted: true });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('changes password through the cookie session and does not return/store a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { mustChangePassword: false } }));

    await changePassword('temporary-password', 'new-password');

    expect(requestBody()).toEqual({
      currentPassword: 'temporary-password',
      newPassword: 'new-password',
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('identifies only explicit expired-session 401 errors', () => {
    expect(isSessionExpiryError(new AuthApiError(401, 'UNAUTHENTICATED'))).toBe(true);
    expect(isSessionExpiryError(new AuthApiError(401, 'SESSION_EXPIRED'))).toBe(true);
    expect(isSessionExpiryError(new AuthApiError(401, 'INVALID_CREDENTIALS'))).toBe(false);
    expect(isSessionExpiryError(new AuthApiError(403, 'FORBIDDEN'))).toBe(false);
  });
});
