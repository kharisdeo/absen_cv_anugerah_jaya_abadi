import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminAuditLogsApi,
  AdminAuditLogsApiError,
  normalizeAdminAuditLogQuery,
} from '../src/api/admin-audit-logs-api.js';

const item = {
  id: '00000000-0000-4000-8000-000000000701',
  actorUserAccountId: '00000000-0000-4000-8000-000000000702',
  occurredAt: '2026-10-11T08:15:00.000Z',
  clientIp: '192.0.2.1',
  deviceIdHash: 'a'.repeat(64),
  action: 'attendance.record.create',
  entityType: 'attendance',
  entityId: '00000000-0000-4000-8000-000000000703',
  beforeData: null,
  afterData: { status: 'PRESENT' },
  reason: null,
  requestId: '00000000-0000-4000-8000-000000000704',
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin audit-log API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends allowlisted filters, pagination, cookie credentials, no-store, and AbortSignal', async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [item], page: 2, pageSize: 1, hasNextPage: true }),
    );

    await expect(
      adminAuditLogsApi.list(
        {
          actorUserAccountId: item.actorUserAccountId,
          action: 'attendance.record.create',
          entityType: 'attendance',
          entityId: item.entityId,
          from: '2026-10-11T00:00:00.000+07:00',
          to: '2026-10-11T23:59:59.999+07:00',
          page: 2,
          pageSize: 1,
        },
        signal,
      ),
    ).resolves.toMatchObject({ items: [item], page: 2, pageSize: 1, hasNextPage: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/admin/audit-logs?actorUserAccountId=00000000-0000-4000-8000-000000000702&action=attendance.record.create&entityType=attendance&entityId=00000000-0000-4000-8000-000000000703&from=2026-10-11T00%3A00%3A00.000%2B07%3A00&to=2026-10-11T23%3A59%3A59.999%2B07%3A00&page=2&pageSize=1',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'GET', credentials: 'include', cache: 'no-store', signal }),
    );
  });

  it('validates query allowlist, UUIDs, bounds, token syntax, and zoned inclusive timestamps', () => {
    expect(normalizeAdminAuditLogQuery({})).toEqual({ page: 1, pageSize: 50 });
    for (const query of [
      { unknown: 'field' },
      { actorUserAccountId: 'not-a-uuid' },
      { actorUserAccountId: '00000000-0000-0000-8000-000000000702' },
      { actorUserAccountId: '00000000-0000-4000-7000-000000000702' },
      { action: ' bad action ' },
      { entityType: 'x'.repeat(101) },
      { entityId: 'x'.repeat(129) },
      { from: '2026-10-11T00:00:00' },
      { from: '2026-10-12T00:00:00+07:00', to: '2026-10-11T23:59:59+07:00' },
      { page: 10_001 },
      { pageSize: 101 },
    ]) {
      expect(() => normalizeAdminAuditLogQuery(query)).toThrow(AdminAuditLogsApiError);
    }
  });

  it('rejects response fields, malformed DTO timestamps, JSON shapes, and pagination mismatches', async () => {
    const cases = [
      { ...item, unexpected: 'field' },
      { ...item, occurredAt: '2026-10-11T08:15:00' },
      { ...item, beforeData: ['not', 'an', 'object'] },
      { ...item, actorUserAccountId: 'not-a-uuid' },
      { ...item, action: 42 },
      { ...item, entityType: null },
    ];
    for (const invalidItem of cases) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ items: [invalidItem], page: 1, pageSize: 50, hasNextPage: false }),
      );
      await expect(adminAuditLogsApi.list({})).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_RESPONSE',
      } satisfies Partial<AdminAuditLogsApiError>);
    }

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [item], page: 2, pageSize: 49, hasNextPage: false }),
    );
    await expect(adminAuditLogsApi.list({ page: 1, pageSize: 50 })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('does not apply query-filter bounds/patterns to unconstrained response DTO strings', async () => {
    const responseItem = {
      ...item,
      action: 'legacy action/value',
      entityType: 'legacy type',
      entityId: 'e'.repeat(129),
      reason: 'r'.repeat(501),
      clientIp: 'i'.repeat(65),
      deviceIdHash: 'h'.repeat(129),
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [responseItem], page: 1, pageSize: 50, hasNextPage: false }),
    );
    await expect(adminAuditLogsApi.list({})).resolves.toMatchObject({ items: [responseItem] });
    expect(() => normalizeAdminAuditLogQuery({ action: responseItem.action })).toThrow(
      AdminAuditLogsApiError,
    );
    expect(() => normalizeAdminAuditLogQuery({ entityType: responseItem.entityType })).toThrow(
      AdminAuditLogsApiError,
    );
  });

  it('maps failures without retaining server detail text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'private server trace', title: 'internal failure' }, 403),
    );
    await expect(adminAuditLogsApi.list({})).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AdminAuditLogsApiError);
      expect(error).toMatchObject({ status: 403 });
      expect((error as Error).message).not.toContain('private server trace');
      expect((error as Error).message).not.toContain('internal failure');
      return true;
    });
  });
});
