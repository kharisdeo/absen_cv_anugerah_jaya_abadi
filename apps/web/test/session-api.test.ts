import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchSessionState } from '../src/auth/session.js';

const fetchMock = vi.fn<typeof fetch>();

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const validSession = {
  user: {
    id: '00000000-0000-4000-8000-000000000101',
    username: 'employee-01',
    role: 'EMPLOYEE',
    employeeId: '00000000-0000-4000-8000-000000000102',
    deviceBindingStatus: 'APPROVED',
    mustChangePassword: false,
    consentRequired: false,
  },
};

describe('session API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads the authenticated session with cookies and no-store cache', async () => {
    fetchMock.mockResolvedValueOnce(response(validSession));

    await expect(fetchSessionState()).resolves.toEqual({
      status: 'authenticated',
      user: validSession.user,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/me',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('maps an expired cookie to unauthenticated without exposing response details', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        { code: 'UNAUTHENTICATED', title: 'private', detail: 'private session detail' },
        401,
      ),
    );

    await expect(fetchSessionState()).resolves.toEqual({ status: 'unauthenticated' });
  });

  it('maps invalid session DTOs and unavailable server errors to unavailable', async () => {
    fetchMock.mockResolvedValueOnce(response({ user: { ...validSession.user, role: 'OWNER' } }));
    fetchMock.mockResolvedValueOnce(
      response({ code: 'INTERNAL_SERVER_ERROR', detail: 'private server detail' }, 500),
    );

    await expect(fetchSessionState()).resolves.toEqual({ status: 'unavailable' });
    await expect(fetchSessionState()).resolves.toEqual({ status: 'unavailable' });
  });
});
