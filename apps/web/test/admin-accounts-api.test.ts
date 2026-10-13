import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminAccountsApiError, adminAccountsApi } from '../src/api/admin-accounts-api.js';

const account = {
  id: '00000000-0000-4000-8000-000000000501',
  username: 'admin.baru',
  role: 'ADMIN',
  status: 'ACTIVE',
  employeeId: null,
  mustChangePassword: true,
  createdAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:00.000Z',
};

const binding = {
  id: '00000000-0000-4000-8000-000000000502',
  employeeId: '00000000-0000-4000-8000-000000000503',
  deviceName: 'Chrome Android',
  status: 'PENDING',
  requestedAt: '2026-10-11T02:00:00.000Z',
  approvedAt: null,
  revokedAt: null,
  createdAt: '2026-10-11T02:00:00.000Z',
  updatedAt: '2026-10-11T02:00:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin accounts API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads only account DTOs over the protected no-store route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...account, secret: 'must not escape' }]));

    await expect(adminAccountsApi.listAccounts()).resolves.toEqual([account]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/accounts',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('uses the exact detail route and rejects an unexpected response status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(account));
    await expect(adminAccountsApi.getAccount(account.id)).resolves.toEqual(account);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/admin/accounts/${account.id}`);

    fetchMock.mockResolvedValueOnce(jsonResponse(account, 201));
    await expect(adminAccountsApi.getAccount(account.id)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminAccountsApiError>);
  });

  it('creates an account with only the supplied fields and returns the one-time server password', async () => {
    const temporaryPassword = 'server-generated-once';
    fetchMock.mockResolvedValueOnce(jsonResponse({ account, temporaryPassword }, 201));

    await expect(
      adminAccountsApi.createAccount({ username: 'admin.baru', role: 'ADMIN' }),
    ).resolves.toEqual({ account, temporaryPassword });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/accounts');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify({ username: 'admin.baru', role: 'ADMIN' }),
      }),
    );
  });

  it('patches only sent fields and deactivates without a hard-delete route', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...account, status: 'SUSPENDED' }));
    await expect(
      adminAccountsApi.updateAccount(account.id, { status: 'SUSPENDED' }),
    ).resolves.toMatchObject({ status: 'SUSPENDED' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/admin/accounts/${account.id}`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED' }) }),
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...account, status: 'INACTIVE' }));
    await expect(adminAccountsApi.deactivateAccount(account.id)).resolves.toMatchObject({
      status: 'INACTIVE',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/accounts/${account.id}/deactivate`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', credentials: 'include', cache: 'no-store' }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('body');
  });

  it('sends only the administrator-supplied reset password and reads the server result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ accountId: account.id, mustChangePassword: true }),
    );
    const password = 'A💠';
    await expect(adminAccountsApi.resetPassword(account.id, password)).resolves.toEqual({
      accountId: account.id,
      mustChangePassword: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/auth/admin/accounts/${account.id}/reset-password`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify({ temporaryPassword: password }),
      }),
    );
  });

  it('lists only pending device bindings without returning unknown token/hash fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ ...binding, deviceToken: 'private-token', deviceIdHash: 'private-hash' }]),
    );
    await expect(adminAccountsApi.listPendingBindings()).resolves.toEqual([binding]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/device-bindings/pending');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', credentials: 'include', cache: 'no-store' }),
    );
  });

  it('uses empty POST bodies for approve and revoke, preserving returned status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...binding, status: 'APPROVED' }));
    await expect(adminAccountsApi.approveBinding(binding.id)).resolves.toMatchObject({
      id: binding.id,
      status: 'APPROVED',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...binding, status: 'REVOKED' }));
    await expect(adminAccountsApi.revokeBinding(binding.id)).resolves.toMatchObject({
      id: binding.id,
      status: 'REVOKED',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/admin/device-bindings/${binding.id}/approve`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/device-bindings/${binding.id}/revoke`);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          body: '{}',
        }),
      );
    }
  });

  it('keeps API error codes but rejects malformed account and device DTOs', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'ACTIVE_ADMIN_FLOOR' }), { status: 409 }),
    );
    await expect(adminAccountsApi.listAccounts()).rejects.toMatchObject({
      status: 409,
      code: 'ACTIVE_ADMIN_FLOOR',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...account, role: 'ROOT' }]));
    await expect(adminAccountsApi.listAccounts()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...binding, status: 'APPROVED' }]));
    await expect(adminAccountsApi.listPendingBindings()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
