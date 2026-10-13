import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminStoresApiError, adminStoresApi } from '../src/api/admin-stores-api.js';

const store = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Toko Contoh',
  address: null,
  latitude: -6.2,
  longitude: 106.8,
  radiusMeters: 10,
  accuracyLimitMeters: 30,
  wifiPublicIp: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin stores API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses the versioned admin store route, cookie credentials, and no-store cache', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([store]));

    await expect(adminStoresApi.listStores()).resolves.toEqual([store]);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/stores',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('sends create and edit payloads to the implemented HTTP methods', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(store, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(store));
    const input = {
      name: 'Toko Contoh',
      address: null,
      latitude: -6.2,
      longitude: 106.8,
      radiusMeters: 10,
      accuracyLimitMeters: 30,
      wifiPublicIp: null,
    };

    await adminStoresApi.createStore(input);
    await adminStoresApi.updateStore(store.id, input);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/stores');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/stores/${store.id}`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(input) }),
    );
  });

  it('uses the assignment routes and requires the server 204 response for removal', async () => {
    const employee = {
      id: '00000000-0000-4000-8000-000000000102',
      nik: 'AJ-001',
      fullName: 'Karyawan Contoh',
      position: null,
      status: 'ACTIVE',
      employmentDate: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const assignment = {
      storeId: store.id,
      employeeId: employee.id,
      assignedByUserAccountId: '00000000-0000-4000-8000-000000000103',
      assignedAt: '2026-01-01T00:00:00.000Z',
      employee: {
        id: employee.id,
        nik: employee.nik,
        fullName: employee.fullName,
        status: employee.status,
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse([employee]));
    fetchMock.mockResolvedValueOnce(jsonResponse([assignment]));
    fetchMock.mockResolvedValueOnce(jsonResponse(assignment));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(adminStoresApi.listEmployees()).resolves.toEqual([employee]);
    await expect(adminStoresApi.listAssignments(store.id)).resolves.toEqual([assignment]);
    await expect(adminStoresApi.assignEmployee(store.id, employee.id)).resolves.toEqual(assignment);
    await expect(adminStoresApi.removeEmployee(store.id, employee.id)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/stores/${store.id}/assignments`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/v1/admin/stores/${store.id}/assignments/${employee.id}`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('does not treat a malformed response as valid server data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...store, latitude: 'unknown' }]));

    await expect(adminStoresApi.listStores()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminStoresApiError>);
  });

  it('maps a forbidden problem response to a safe typed error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'FORBIDDEN' }),
        { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    await expect(adminStoresApi.listStores()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    } satisfies Partial<AdminStoresApiError>);
  });
});
