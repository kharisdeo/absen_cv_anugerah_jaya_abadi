import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toUserErrorMessage } from '../src/api/error-message.js';
import {
  acceptCurrentConsent,
  AuthApiError,
  changePassword,
  getCurrentConsent,
  isSessionExpiryError,
  login,
} from '../src/auth/auth-api.js';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(body) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth API client', () => {
  it('submits login with a cookie session and no browser-persisted device/auth token by default', async () => {
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

  it('accepts an explicitly injected device identity without storing or changing it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: {}, consentRequired: false }));
    const deviceInfo = { deviceToken: 'random-browser-install-id', deviceName: 'Peramban kerja' };

    await login('employee', 'secret-password', async () => deviceInfo);

    expect(requestBody()).toEqual({
      identifier: 'employee',
      password: 'secret-password',
      ...deviceInfo,
    });
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
