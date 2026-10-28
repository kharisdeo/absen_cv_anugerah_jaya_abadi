import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeSystemDisruptionQuery,
  SystemDisruptionsApiError,
  systemDisruptionsApi,
} from '../src/api/system-disruptions-api.js';

const storeId = '00000000-0000-4000-8000-000000000101';
const idempotencyKey = '10000000-0000-4000-8000-000000000001';
const disruption = {
  id: '00000000-0000-4000-8000-000000000102',
  storeId: null,
  startsAt: '2026-10-11T02:00:00.000Z',
  endsAt: '2026-10-11T04:00:00.000Z',
  reason: 'Gangguan koneksi pusat',
  isActive: true,
  createdAt: '2026-10-11T01:30:00.000Z',
  updatedAt: '2026-10-11T01:30:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('system disruptions API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('requests all scopes or an exact store filter with bounded pagination and an abort signal', async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [disruption], page: 1, pageSize: 25, hasNextPage: false }),
    );

    await expect(
      systemDisruptionsApi.list({ page: 1, pageSize: 25 }, signal),
    ).resolves.toMatchObject({
      items: [disruption],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/admin/system-disruptions?page=1&pageSize=25',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', credentials: 'include', cache: 'no-store', signal }),
    );

    expect(() =>
      normalizeSystemDisruptionQuery({ storeId, page: 1, pageSize: 25, active: true }),
    ).toThrow(TypeError);
    expect(() =>
      normalizeSystemDisruptionQuery({ storeId: 'invalid', page: 1, pageSize: 25 }),
    ).toThrow(TypeError);
  });

  it('rejects malformed DTOs, invalid intervals, non-enum status types, and timezone-free timestamps', async () => {
    const badRows = [
      { ...disruption, startsAt: '2026-10-11T09:00:00' },
      { ...disruption, endsAt: disruption.startsAt },
      { ...disruption, isActive: 'ACTIVE' },
      { ...disruption, unexpected: 'field' },
    ];
    for (const row of badRows) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ items: [row], page: 1, pageSize: 25, hasNextPage: false }),
      );
      await expect(systemDisruptionsApi.list({ page: 1, pageSize: 25 })).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_RESPONSE',
      } satisfies Partial<SystemDisruptionsApiError>);
    }
  });

  it('sends one confirmed create request with the strict body and validates 201 response', async () => {
    const input = {
      storeId: null,
      startsAt: '2026-10-11T09:00:00+07:00',
      endsAt: '2026-10-11T11:00:00+07:00',
      reason: 'Gangguan koneksi pusat',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(disruption, 201));

    await expect(systemDisruptionsApi.create(input, idempotencyKey)).resolves.toEqual(disruption);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/system-disruptions');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(input),
      }),
    );
    await expect(
      systemDisruptionsApi.create({ ...input, startsAt: '2026-10-11T09:00' }, idempotencyKey),
    ).rejects.toThrow(TypeError);
    await expect(systemDisruptionsApi.create(input, 'not-a-random-uuid')).rejects.toThrow(
      TypeError,
    );
  });
});
