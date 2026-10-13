import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminHolidaysApiError, adminHolidaysApi } from '../src/api/admin-holidays-api.js';

const holiday = {
  id: '00000000-0000-4000-8000-000000000601',
  storeId: null,
  holidayDate: '2028-02-29',
  description: 'Libur nasional',
  createdAt: '2026-10-10T08:00:00.000Z',
};
const storeId = '00000000-0000-4000-8000-000000000602';
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin holidays API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads all scopes without query parameters and uses authenticated no-store requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([holiday]));

    await expect(adminHolidaysApi.listHolidays()).resolves.toEqual([holiday]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/holidays',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('encodes the national, store, and date filters according to the API contract', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await adminHolidaysApi.listHolidays({ storeId: 'national' });
    await adminHolidaysApi.listHolidays({
      from: '2028-02-01',
      to: '2028-02-29',
      storeId,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/holidays?storeId=national');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/admin/holidays?from=2028-02-01&to=2028-02-29&storeId=${storeId}`,
    );
  });

  it('sends national create as null, patches only requested fields, and requires DELETE 204', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(holiday, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...holiday, description: 'Libur baru' }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await adminHolidaysApi.createHoliday({
      storeId: null,
      holidayDate: holiday.holidayDate,
      description: holiday.description,
    });
    await adminHolidaysApi.updateHoliday(holiday.id, { description: 'Libur baru' });
    await adminHolidaysApi.deleteHoliday(holiday.id);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/holidays');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          storeId: null,
          holidayDate: holiday.holidayDate,
          description: holiday.description,
        }),
      }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/holidays/${holiday.id}`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ description: 'Libur baru' }),
      }),
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/v1/admin/holidays/${holiday.id}`);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock.mock.calls[2]?.[1]).not.toHaveProperty('body');
  });

  it('rejects malformed, impossible-date, and extra-field DTOs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...holiday, holidayDate: '2028-02-30' }]));
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...holiday, raw: 'unexpected' }]));

    await expect(adminHolidaysApi.listHolidays()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminHolidaysApiError>);
    await expect(adminHolidaysApi.listHolidays()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminHolidaysApiError>);
  });

  it('rejects a non-204 delete response and empty PATCH without sending a request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(adminHolidaysApi.deleteHoliday(holiday.id)).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_RESPONSE',
    } satisfies Partial<AdminHolidaysApiError>);
    await expect(adminHolidaysApi.updateHoliday(holiday.id, {})).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_SCHEDULE_INPUT',
    } satisfies Partial<AdminHolidaysApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains only the stable server code for safe allowlist messaging', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          title: 'Sensitive title',
          detail: 'Raw server details',
          code: 'HOLIDAY_DATE_CONFLICT',
        }),
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    await expect(
      adminHolidaysApi.createHoliday({
        storeId: null,
        holidayDate: holiday.holidayDate,
        description: holiday.description,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'HOLIDAY_DATE_CONFLICT',
      message: 'Permintaan pengelolaan hari libur belum berhasil.',
    });
  });
});
