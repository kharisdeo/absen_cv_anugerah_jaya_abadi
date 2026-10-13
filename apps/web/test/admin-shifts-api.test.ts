import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminShiftsApiError, adminShiftsApi } from '../src/api/admin-shifts-api.js';

const shift = {
  id: '00000000-0000-4000-8000-000000000401',
  name: 'Shift Pagi',
  startTime: '08:00:00',
  endTime: '17:00:00',
  breakMinutes: 60,
  lateToleranceMinutes: 10,
  workDays: [1, 2, 3, 4, 5],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const input = {
  name: 'Shift Pagi',
  startTime: '08:00:00',
  endTime: '17:00:00',
  breakMinutes: 60,
  lateToleranceMinutes: 10,
  workDays: [1, 2, 3, 4, 5],
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin shifts API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads server shifts from the versioned Admin endpoint without caching', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([shift]));

    await expect(adminShiftsApi.listShifts()).resolves.toEqual([shift]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/shifts',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('uses POST, PATCH, and the dedicated deactivate endpoint with exact payloads', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(shift, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(shift));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...shift, isActive: false }));

    await adminShiftsApi.createShift(input);
    await adminShiftsApi.updateShift(shift.id, { breakMinutes: 30 });
    await adminShiftsApi.deactivateShift(shift.id);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/shifts');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/shifts/${shift.id}`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ breakMinutes: 30 }) }),
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/v1/admin/shifts/${shift.id}/deactivate`);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(fetchMock.mock.calls[2]?.[1]).not.toHaveProperty('body');
  });

  it('rejects malformed shift DTOs and does not accept an active deactivate response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...shift, workDays: [1, 1] }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(shift));

    await expect(adminShiftsApi.listShifts()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminShiftsApiError>);
    await expect(adminShiftsApi.deactivateShift(shift.id)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminShiftsApiError>);
  });

  it('retains only the stable error code instead of rendering raw server problem text', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: 'Private server text', detail: 'Do not show', code: 'FORBIDDEN' }),
        { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    await expect(adminShiftsApi.listShifts()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    } satisfies Partial<AdminShiftsApiError>);
  });
});
