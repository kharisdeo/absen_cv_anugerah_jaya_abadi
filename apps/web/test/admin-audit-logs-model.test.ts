import { describe, expect, it, vi } from 'vitest';

import type {
  AdminAuditLogItem,
  AdminAuditLogPage,
  AdminAuditLogQuery,
} from '../src/api/admin-audit-logs-api.js';
import {
  AdminAuditLogsModel,
  EMPTY_ADMIN_AUDIT_LOG_FILTERS,
} from '../src/pages/admin-audit-logs-model.js';

const item: AdminAuditLogItem = {
  id: '00000000-0000-4000-8000-000000000711',
  actorUserAccountId: '00000000-0000-4000-8000-000000000712',
  occurredAt: '2026-10-11T08:15:00.000Z',
  clientIp: null,
  deviceIdHash: null,
  action: 'attendance.record.create',
  entityType: 'attendance',
  entityId: '00000000-0000-4000-8000-000000000713',
  beforeData: null,
  afterData: { status: 'PRESENT' },
  reason: null,
  requestId: null,
};

function page(overrides: Partial<AdminAuditLogPage> = {}): AdminAuditLogPage {
  return { items: [item], page: 1, pageSize: 50, hasNextPage: true, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AdminAuditLogsModel', () => {
  it('loads ready/empty/error states, pages forward, and resets page on filter changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page({ page: 2, hasNextPage: false }))
      .mockResolvedValueOnce(page({ items: [], page: 1, hasNextPage: false }))
      .mockRejectedValueOnce(new Error('private server detail'));
    const model = new AdminAuditLogsModel({ list });

    expect(model.getSnapshot().status).toBe('loading');
    expect(await model.load()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', page: 1, items: [item] });
    model.goToPage(2);
    expect(model.getSnapshot().page).toBe(2);
    expect(await model.load()).toBe(true);
    expect(model.getSnapshot().page).toBe(2);

    expect(
      model.setFilters({ ...EMPTY_ADMIN_AUDIT_LOG_FILTERS, action: 'attendance.record.create' }),
    ).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ page: 1, status: 'loading', items: [] });
    expect(await model.load()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', items: [] });
    expect(await model.load()).toBe(false);
    expect(model.getSnapshot().status).toBe('error');
    expect(list.mock.calls.map(([query]) => query)).toEqual([
      { page: 1, pageSize: 50 },
      { page: 2, pageSize: 50 },
      { action: 'attendance.record.create', page: 1, pageSize: 50 },
      { action: 'attendance.record.create', page: 1, pageSize: 50 },
    ]);
  });

  it('serializes date-only filters to explicit inclusive Asia/Jakarta boundaries', async () => {
    const list = vi.fn().mockResolvedValue(page({ hasNextPage: false }));
    const model = new AdminAuditLogsModel({ list });
    model.setFilters({
      ...EMPTY_ADMIN_AUDIT_LOG_FILTERS,
      fromDate: '2026-10-11',
      toDate: '2026-10-12',
    });
    await model.load();
    expect(list).toHaveBeenCalledWith(
      {
        from: '2026-10-11T00:00:00.000+07:00',
        to: '2026-10-12T23:59:59.999+07:00',
        page: 1,
        pageSize: 50,
      },
      expect.any(AbortSignal),
    );
  });

  it('rejects invalid filters without requesting and prevents duplicate concurrent fetches', async () => {
    const pending = deferred<AdminAuditLogPage>();
    const list = vi.fn(() => pending.promise);
    const model = new AdminAuditLogsModel({ list });
    expect(
      model.setFilters({
        ...EMPTY_ADMIN_AUDIT_LOG_FILTERS,
        fromDate: '2026-10-12',
        toDate: '2026-10-11',
      }),
    ).toBe(false);
    expect(model.getSnapshot().filterError).toContain('tidak boleh melewati');
    expect(list).not.toHaveBeenCalled();

    const first = model.load();
    const duplicate = model.load();
    expect(duplicate).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve(page({ hasNextPage: false }));
    await expect(first).resolves.toBe(true);
  });

  it('aborts superseded requests and ignores late responses from older filters', async () => {
    const firstResponse = deferred<AdminAuditLogPage>();
    const secondResponse = deferred<AdminAuditLogPage>();
    const signals: AbortSignal[] = [];
    const queries: AdminAuditLogQuery[] = [];
    const list = vi.fn((...args: [AdminAuditLogQuery, AbortSignal?]) => {
      queries.push(args[0]);
      if (args[1]) signals.push(args[1]);
      return queries.length === 1 ? firstResponse.promise : secondResponse.promise;
    });
    const model = new AdminAuditLogsModel({ list });
    const firstLoad = model.load();
    const firstSignal = signals[0];

    model.setFilters({ ...EMPTY_ADMIN_AUDIT_LOG_FILTERS, entityType: 'attendance' });
    expect(firstSignal?.aborted).toBe(true);
    const secondLoad = model.load();
    secondResponse.resolve(
      page({ items: [{ ...item, action: 'latest.action' }], hasNextPage: false }),
    );
    await expect(secondLoad).resolves.toBe(true);
    firstResponse.resolve(
      page({ items: [{ ...item, action: 'stale.action' }], hasNextPage: false }),
    );
    await expect(firstLoad).resolves.toBe(false);
    expect(model.getSnapshot().items[0]?.action).toBe('latest.action');
    expect(queries).toEqual([
      { page: 1, pageSize: 50 },
      { entityType: 'attendance', page: 1, pageSize: 50 },
    ]);
  });
});
