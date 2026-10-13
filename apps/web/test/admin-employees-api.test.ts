import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminEmployeesApiError, adminEmployeesApi } from '../src/api/admin-employees-api.js';

const employee = {
  id: '00000000-0000-4000-8000-000000000301',
  nik: 'AJ-001',
  fullName: 'Nama Karyawan',
  position: null,
  status: 'ACTIVE',
  employmentDate: null,
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

describe('admin employees API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads employee profiles from the protected versioned route without caching', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([employee]));

    await expect(adminEmployeesApi.listEmployees()).resolves.toEqual([employee]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/employees',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('uses exact create, detail, and patch routes with matching status codes', async () => {
    const input = {
      nik: 'AJ-002',
      fullName: 'Nama Baru',
      position: null,
      employmentDate: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(employee, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(employee));
    fetchMock.mockResolvedValueOnce(jsonResponse(employee));

    await expect(adminEmployeesApi.createEmployee(input)).resolves.toEqual(employee);
    await expect(adminEmployeesApi.getEmployee(employee.id)).resolves.toEqual(employee);
    await expect(
      adminEmployeesApi.updateEmployee(employee.id, { position: 'Supervisor' }),
    ).resolves.toEqual(employee);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/employees');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/employees/${employee.id}`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ position: 'Supervisor' }),
      }),
    );
  });

  it('uses the deactivate endpoint and maps server problem codes safely', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...employee, status: 'INACTIVE' }));
    await expect(adminEmployeesApi.deactivateEmployee(employee.id)).resolves.toMatchObject({
      status: 'INACTIVE',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/admin/employees/${employee.id}/deactivate`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 409, code: 'EMPLOYEE_NIK_CONFLICT' }), {
        status: 409,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );
    await expect(
      adminEmployeesApi.createEmployee({
        nik: 'AJ-001',
        fullName: 'Nama Baru',
        position: null,
        employmentDate: null,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'EMPLOYEE_NIK_CONFLICT',
    } satisfies Partial<AdminEmployeesApiError>);
  });
});
