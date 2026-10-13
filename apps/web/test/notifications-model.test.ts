import { describe, expect, it, vi } from 'vitest';

import type { NotificationDto, NotificationPage } from '../src/api/notifications-api.js';
import { NotificationsModel } from '../src/pages/notifications-model.js';

const item: NotificationDto = {
  id: '00000000-0000-4000-8000-000000000101',
  kind: 'ATTENDANCE_REQUEST',
  title: 'Pengajuan baru',
  message: 'Ada pengajuan yang perlu diperiksa.',
  readAt: null,
  createdAt: '2026-10-11T08:15:00.000Z',
};

function page(overrides: Partial<NotificationPage> = {}): NotificationPage {
  return {
    items: [item],
    page: 1,
    pageSize: 25,
    hasNextPage: true,
    unreadCount: 1,
    ...overrides,
  };
}

describe('NotificationsModel', () => {
  it('loads ready, error, and empty states and resets pagination when the filter changes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page({ page: 2 }))
      .mockResolvedValueOnce(page({ items: [], page: 1, hasNextPage: false, unreadCount: 0 }))
      .mockRejectedValueOnce(new Error('offline'));
    const model = new NotificationsModel({ list, markRead: vi.fn() });

    expect(await model.load()).toBe(true);
    expect(model.getSnapshot().status).toBe('ready');
    model.goToPage(2);
    expect(model.getSnapshot().page).toBe(2);
    expect(await model.load()).toBe(true);
    model.setReadFilter('READ');
    expect(model.getSnapshot().page).toBe(1);
    expect(model.getSnapshot().readFilter).toBe('READ');
    expect(await model.load()).toBe(true);
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', items: [], unreadCount: 0 });
    expect(await model.load()).toBe(false);
    expect(model.getSnapshot().status).toBe('error');
    expect(list.mock.calls.map(([query]) => query)).toEqual([
      { read: 'ALL', page: 1, pageSize: 25 },
      { read: 'ALL', page: 2, pageSize: 25 },
      { read: 'READ', page: 1, pageSize: 25 },
      { read: 'READ', page: 1, pageSize: 25 },
    ]);
  });

  it('allows only one mark-read mutation at a time and schedules a refreshed list', async () => {
    let resolveRead!: (value: Readonly<{ id: string; readAt: string }>) => void;
    const markRead = vi.fn(
      () =>
        new Promise<Readonly<{ id: string; readAt: string }>>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const model = new NotificationsModel({ list: vi.fn(), markRead });

    const first = model.markRead(item.id);
    await expect(model.markRead(item.id)).resolves.toBe(false);
    expect(markRead).toHaveBeenCalledTimes(1);
    resolveRead({ id: item.id, readAt: '2026-10-11T08:20:00.000Z' });
    await expect(first).resolves.toBe(true);
    expect(model.getSnapshot().refreshVersion).toBe(1);
  });

  it('does not publish an aborted or stale response', async () => {
    let rejectList!: (error: Error) => void;
    const list = vi.fn(
      () =>
        new Promise<NotificationPage>((_resolve, reject) => {
          rejectList = reject;
        }),
    );
    const model = new NotificationsModel({ list, markRead: vi.fn() });
    const controller = new AbortController();
    const loading = model.load(controller.signal);
    controller.abort();
    rejectList(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(loading).resolves.toBe(false);
    expect(model.getSnapshot().status).toBe('loading');
    expect(model.getSnapshot().error).toBeNull();
  });
});
